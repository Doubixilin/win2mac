'use strict';

const fs = require('fs');
const path = require('path');

// 快速切换配对时，旧 Relay 的回滚可能仍在进行。文件相同的实例共享在途批次锁。
const fileLocks = new Map();

// 每个配对和接收设备各有一本回执。接收历史可以清空，回执仍须能识别中转积压的旧批次。
class BatchReceipts {
  constructor(file) {
    this.file = file && path.resolve(file);
    this.records = {};
    this.pending = this.file ? fileLocks : new Map();
    this.unsavedDeclines = new Set();
  }

  read() {
    if (!this.file) return this.records;
    let records;
    try { records = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return {}; throw e; }
    if (!records || Array.isArray(records) || typeof records !== 'object' ||
        !Object.values(records).every(s => ['publishing', 'delivered', 'declined'].includes(s))) {
      throw new Error('文件接收回执无法读取，请检查 ' + this.file);
    }
    return records;
  }

  outcome(key) {
    if (this.unsavedDeclines.has(key)) this.decline(key);
    const status = this.read()[key];
    if (status === 'publishing') {
      // 活跃发布持有同批次的锁。取得锁后还能看到该标记，说明上个进程在发布中退出。
      throw new Error('上次接收在文件发布期间中断，请核对接收目录后按需重新发送。');
    }
    return status;
  }

  decline(key) {
    if (!key) return;
    // 磁盘暂时不可写时，重投先补写用户的拒收决定，不能重新进入文件发布流程。
    this.unsavedDeclines.add(key);
    this.save(key, 'declined');
    this.unsavedDeclines.delete(key);
  }

  save(key, status) {
    if (!key) return;
    // 读取最新快照并同步替换，避免上一轮配对的收尾写入覆盖新实例的回执。
    const next = this.read();
    if (next[key] === status) return;
    if (status) next[key] = status; else delete next[key];
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = this.file + '.tmp';
      fs.writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flush: true });
      fs.renameSync(temp, this.file);
    }
  }

  // 两条路径可以同时到达。后到的一方等先到的落盘或回滚完，再读取最终回执。
  async acquire(key) {
    if (this.file) key = JSON.stringify([this.file, key]);
    while (this.pending.has(key)) await this.pending.get(key);
    let release;
    this.pending.set(key, new Promise(resolve => { release = resolve; }));
    return () => { this.pending.delete(key); release(); };
  }
}

module.exports = { BatchReceipts };
