const Datastore = require('nedb');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// cria datastores
const customersDb = new Datastore({ filename: path.join(dataDir, 'customers.db'), autoload: true });
const vehiclesDb = new Datastore({ filename: path.join(dataDir, 'vehicles.db'), autoload: true });
const servicesDb = new Datastore({ filename: path.join(dataDir, 'services.db'), autoload: true });
const appointmentsDb = new Datastore({ filename: path.join(dataDir, 'appointments.db'), autoload: true });
const partsDb = new Datastore({ filename: path.join(dataDir, 'parts.db'), autoload: true });
const purchasesDb = new Datastore({ filename: path.join(dataDir, 'purchases.db'), autoload: true });
const salesDb = new Datastore({ filename: path.join(dataDir, 'sales.db'), autoload: true });

// helper que cria um objeto com API compatível com o que server.js usa:
function wrap(db) {
  return {
    find: (query = {}) => ({
      sort: (sortObj = {}) =>
        new Promise((resolve, reject) => {
          db.find(query).sort(sortObj).exec((err, docs) => (err ? reject(err) : resolve(docs)));
        })
    }),
    findOne: (query = {}) =>
      new Promise((resolve, reject) => {
        db.findOne(query, (err, doc) => (err ? reject(err) : resolve(doc)));
      }),
    insert: (doc) =>
      new Promise((resolve, reject) => {
        db.insert(doc, (err, newDoc) => (err ? reject(err) : resolve(newDoc)));
      }),
    count: (query = {}) =>
      new Promise((resolve, reject) => {
        db.count(query, (err, count) => (err ? reject(err) : resolve(count)));
      }),
    update: (query, updateObj, opts = {}) =>
      new Promise((resolve, reject) => {
        db.update(query, updateObj, opts, (err, numAffected) => (err ? reject(err) : resolve(numAffected)));
      }),
    remove: (query, opts = {}) =>
      new Promise((resolve, reject) => {
        db.remove(query, opts, (err, numRemoved) => (err ? reject(err) : resolve(numRemoved)));
      }),
    ensureIndex: (opts) => {
      try { db.ensureIndex(opts, () => {}); } catch(e) {}
    }
  };
}

const customers = wrap(customersDb);
const vehicles = wrap(vehiclesDb);
const services = wrap(servicesDb);
const appointments = wrap(appointmentsDb);
const parts = wrap(partsDb);
const purchases = wrap(purchasesDb);
const sales = wrap(salesDb);

// índices
customers.ensureIndex({ fieldName: 'created_at' });
vehicles.ensureIndex({ fieldName: 'customer_id' });
vehicles.ensureIndex({ fieldName: 'created_at' });
services.ensureIndex({ fieldName: 'created_at' });
appointments.ensureIndex({ fieldName: 'vehicle_id' });
appointments.ensureIndex({ fieldName: 'scheduled_at' });
parts.ensureIndex({ fieldName: 'sku' });
parts.ensureIndex({ fieldName: 'created_at' });
purchases.ensureIndex({ fieldName: 'created_at' });
sales.ensureIndex({ fieldName: 'created_at' });

module.exports = {
  customers,
  vehicles,
  services,
  appointments,
  parts,
  purchases,
  sales
};