'use strict';
/**
 * Tiny JSON document store. Plenty for a single-node control panel.
 * Data lives in <dataDir>/db.json and is written atomically on change.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const FILE = path.join(config.dataDir, 'db.json');

const empty = () => ({ users: [], plans: [], sites: [], databases: [], zones: [], meta: {} });

let data;
try {
  data = { ...empty(), ...JSON.parse(fs.readFileSync(FILE, 'utf8')) };
} catch {
  data = empty();
}

function save() {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

const db = {
  data,
  save,
  all: (c) => data[c],
  find: (c, fn) => data[c].filter(fn),
  findOne: (c, fn) => data[c].find(fn),
  get: (c, id) => data[c].find((x) => x.id === id),
  insert(c, doc) {
    doc.id = crypto.randomBytes(8).toString('hex');
    doc.createdAt = Date.now();
    data[c].push(doc);
    save();
    return doc;
  },
  update(c, id, patch) {
    const doc = db.get(c, id);
    if (!doc) return null;
    Object.assign(doc, patch);
    save();
    return doc;
  },
  remove(c, id) {
    const i = data[c].findIndex((x) => x.id === id);
    if (i === -1) return false;
    data[c].splice(i, 1);
    save();
    return true;
  }
};

module.exports = db;
