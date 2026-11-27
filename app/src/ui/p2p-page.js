'use strict';
// 直连页面：跑在一个不显示的窗口里，用 WebRTC 和另一台设备建立加密的点对点通道。
//
// 主进程发来的命令（op）：
//   connect     { peer, sid, role: 'offer' | 'answer', iceServers, primary }   为这台设备新建连接；
//               primary 是 iceServers 里作为主参照的那几个地址，见 candidateFilter
//   signal      { peer, sid, type: 'offer' | 'answer' | 'cand', data } 对方经中转送来的连接信息
//   close-peer  { peer }
//   open-link   { peer, link }                                          在已有连接上开一条通道
//   send        { link, seq, data }                                     data 是字符串或字节
//   close-link  { link }
// 发回主进程的事件（ev）：
//   ready
//   signal      { peer, sid, type, data }                               需要转给对方的连接信息
//   peer-up     { peer, sid, route: 'lan' | 'wan', info }               连接已打通
//   diag        { peer, sid, text }                                     给人看的诊断信息（用了哪些地址、为什么）
//   peer-down   { peer, sid }                                           没打通，或者断了
//   link-open   { link } / link-in { peer, link } / link-msg { link, data } / link-sent { link, seq } / link-close { link }

const emit = (evt) => window.w2mP2P.emit(evt);
const peers = new Map(); // 设备编号 -> { pc, sid, ctl, queued, remoteSet, up, lost }
const links = new Map(); // 通道编号 -> RTCDataChannel

const BUFFER_HIGH = 8 * 2 ** 20;
const BUFFER_LOW = 1 * 2 ** 20;
const LOST_MS = 8e3; // 连接中断这么久还没恢复就放弃
const SRFLX_HOLD_MS = 1200; // 公网候选地址攒这么久再发，好比较同一块网卡从不同服务器查到的结果

// 代理软件虚拟网卡上的地址，对直连没有用
const bogusAddress = (a) => /^(198\.1[89]\.|0\.)/.test(String(a || ''));

/**
 * 决定把哪些本机候选地址告诉对方。
 * 本机地址直接发。公网地址（向 STUN 服务器查到的）先攒一下再定，每块网卡只认“主参照服务器”（列表里排最前的两个）的结果：
 *   - 两个主参照查到的结果一致：这块网卡能打洞，发这个地址；
 *   - 不一致：它后面是对称型 NAT，每个目的地换一个端口，对方连不上，这块网卡的公网地址都不发；
 *   - 其余服务器查到的不同结果一律不用。网络按目的地分流时（代理、多出口），它们看到的可能是绕远路的出口，
 *     连得上但很慢，而 WebRTC 并不会因为慢就不选它。
 * 主参照都没有回应时，退而用其余服务器的结果，同样要求一致。
 */
function candidateFilter(send, primaryUrls, report = () => {}) {
  const held = new Map(); // 网卡地址:端口 -> { primary: [], other: [] }
  const decided = new Set();
  let timer = null;
  const same = (list) => new Set(list.map((c) => `${c.address}:${c.port}`)).size === 1;
  const show = (list) => list.map((c) => `${c.address}:${c.port}`).join(' ') || '无';
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    for (const [base, g] of held) {
      decided.add(base);
      const use = g.primary.length ? g.primary : g.other;
      const ok = use.length && same(use);
      if (ok) send(use[0]);
      report(`网卡 ${base}：主参照查到 ${show(g.primary)}；其余查到 ${show(g.other)} → ${ok ? '用 ' + show([use[0]]) : '不用（结果不一致，打不了洞）'}`);
    }
    held.clear();
  };
  return (c) => {
    if (!c) { flush(); return; } // 收集结束
    if (bogusAddress(c.address) || bogusAddress(c.relatedAddress)) return;
    if (c.type !== 'srflx') { if (c.type === 'host' && c.protocol === 'udp') report(`本机地址 ${c.address}`); send(c); return; }
    const base = `${c.relatedAddress}:${c.relatedPort}`;
    if (decided.has(base)) return; // 已经定过了，后到的不再补发
    if (!held.has(base)) held.set(base, { primary: [], other: [] });
    held.get(base)[primaryUrls.includes(c.url) ? 'primary' : 'other'].push(c);
    if (!timer) timer = setTimeout(flush, SRFLX_HOLD_MS);
  };
}

function closePeer(peerId) {
  const st = peers.get(peerId);
  if (!st) return;
  peers.delete(peerId);
  clearTimeout(st.lost);
  for (const [id, dc] of links) {
    if (dc._peer !== peerId) continue;
    links.delete(id);
    emit({ ev: 'link-close', link: id });
  }
  try { st.pc.close(); } catch {}
}

function down(peerId, st) {
  if (peers.get(peerId) !== st) return;
  closePeer(peerId);
  emit({ ev: 'peer-down', peer: peerId, sid: st.sid });
}

async function describeRoute(pc) {
  const stats = await pc.getStats();
  let pair = null;
  stats.forEach((s) => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
  if (!pair) stats.forEach((s) => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
  const local = pair && stats.get(pair.localCandidateId);
  const remote = pair && stats.get(pair.remoteCandidateId);
  const brief = (c) => (c ? { type: c.candidateType, protocol: c.protocol, network: c.networkType || '' } : null);
  // 对方的地址是内网地址，说明两台电脑在同一个局域网里，没有绕公网
  const addr = String(remote?.address || remote?.ip || '');
  const lan = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|127\.|169\.254\.|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:|::1$)/i.test(addr)
    || (local?.candidateType === 'host' && remote?.candidateType === 'host');
  return { route: lan ? 'lan' : 'wan', info: { local: brief(local), remote: brief(remote) } };
}

function wireLink(dc, peerId, st, incoming) {
  const id = dc.label;
  dc._peer = peerId;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = BUFFER_LOW;
  links.set(id, dc);
  const opened = () => emit({
    ev: incoming ? 'link-in' : 'link-open', peer: peerId, sid: st.sid, link: id,
    maxMessageSize: st.pc.sctp?.maxMessageSize,
  });
  if (dc.readyState === 'open') opened(); else dc.onopen = opened;
  dc.onmessage = (e) => emit({ ev: 'link-msg', link: id, data: e.data });
  dc.onclose = () => { if (links.get(id) === dc) { links.delete(id); emit({ ev: 'link-close', link: id }); } };
}

async function connect({ peer, sid, role, iceServers, primary }) {
  closePeer(peer);
  const pc = new RTCPeerConnection({ iceServers: iceServers || [] });
  const st = { pc, sid, ctl: null, queued: [], remoteSet: false, up: false, lost: null };
  peers.set(peer, st);

  const ctlOpen = async (dc) => {
    st.ctl = dc;
    const ready = async () => {
      if (peers.get(peer) !== st || st.up) return;
      st.up = true;
      let desc = { route: 'wan', info: null };
      try { desc = await describeRoute(pc); } catch {}
      if (peers.get(peer) === st) emit({ ev: 'peer-up', peer, sid, ...desc });
    };
    if (dc.readyState === 'open') ready(); else dc.onopen = ready;
    dc.onclose = () => down(peer, st);
  };

  const offerCandidate = candidateFilter((c) => {
    if (peers.get(peer) === st) emit({ ev: 'signal', peer, sid, type: 'cand', data: c.toJSON() });
  }, primary || [], (text) => { if (peers.get(peer) === st) emit({ ev: 'diag', peer, sid, text }); });
  emit({ ev: 'diag', peer, sid, text: `开始连接（${role === 'offer' ? '本机发起' : '对方发起'}），STUN：${(iceServers || []).flatMap((x) => x.urls).join(' ') || '无'}；主参照：${(primary || []).join(' ') || '无'}` });
  pc.onicecandidate = (e) => offerCandidate(e.candidate);
  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    clearTimeout(st.lost);
    if (s === 'failed' || s === 'closed') down(peer, st);
    else if (s === 'disconnected') st.lost = setTimeout(() => down(peer, st), LOST_MS);
  };
  pc.ondatachannel = (e) => {
    if (e.channel.label === 'ctl') ctlOpen(e.channel);
    else wireLink(e.channel, peer, st, true);
  };

  if (role === 'offer') {
    // 这条通道本身不传东西，有它在连接才会完整建立起来，之后再开的通道不用重新协商
    ctlOpen(pc.createDataChannel('ctl'));
    await pc.setLocalDescription(await pc.createOffer());
    if (peers.get(peer) === st) emit({ ev: 'signal', peer, sid, type: 'offer', data: pc.localDescription.sdp });
  }
}

async function signal({ peer, sid, type, data }) {
  const st = peers.get(peer);
  if (!st || st.sid !== sid) return;
  const pc = st.pc;
  if (type === 'cand') {
    if (!st.remoteSet) { st.queued.push(data); return; }
    await pc.addIceCandidate(data).catch(() => {});
    return;
  }
  await pc.setRemoteDescription({ type, sdp: data });
  st.remoteSet = true;
  for (const c of st.queued.splice(0)) await pc.addIceCandidate(c).catch(() => {});
  if (type === 'offer') {
    await pc.setLocalDescription(await pc.createAnswer());
    if (peers.get(peer) === st) emit({ ev: 'signal', peer, sid, type: 'answer', data: pc.localDescription.sdp });
  }
}

async function send({ link, seq, data }) {
  const dc = links.get(link);
  if (!dc || dc.readyState !== 'open') return; // 通道关闭事件会让主进程里等着的发送失败
  dc.send(data);
  if (dc.bufferedAmount > BUFFER_HIGH) {
    await new Promise((resolve) => {
      const done = () => { dc.removeEventListener('bufferedamountlow', done); dc.removeEventListener('close', done); resolve(); };
      dc.addEventListener('bufferedamountlow', done);
      dc.addEventListener('close', done);
    });
  }
  emit({ ev: 'link-sent', link, seq });
}

window.w2mP2P.onCmd((cmd) => {
  const fail = (e) => {
    console.error('p2p', cmd.op, e);
    if (cmd.op === 'connect' || cmd.op === 'signal') { const st = peers.get(cmd.peer); if (st && st.sid === cmd.sid) down(cmd.peer, st); }
    if (cmd.op === 'send' || cmd.op === 'open-link') {
      const dc = links.get(cmd.link);
      if (dc) { try { dc.close(); } catch {} }
      else emit({ ev: 'link-close', link: cmd.link });
    }
  };
  try {
    if (cmd.op === 'connect') connect(cmd).catch(fail);
    else if (cmd.op === 'signal') signal(cmd).catch(fail);
    else if (cmd.op === 'close-peer') closePeer(cmd.peer);
    else if (cmd.op === 'open-link') {
      const st = peers.get(cmd.peer);
      if (!st) throw new Error('没有到这台设备的连接');
      wireLink(st.pc.createDataChannel(cmd.link, { ordered: true }), cmd.peer, st, false);
    } else if (cmd.op === 'send') send(cmd).catch(fail);
    else if (cmd.op === 'close-link') { const dc = links.get(cmd.link); if (dc) dc.close(); }
  } catch (e) { fail(e); }
});

emit({ ev: 'ready' });
