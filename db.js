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

// helper que cria um objeto com API compatível com o que server.js usa:
// - customers.find(query).sort({...}) -> Promise<array>
// - customers.findOne(query) -> Promise<object>
// - customers.insert(obj) -> Promise<object>
// - customers.count(query) -> Promise<number>
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
    ensureIndex: (opts) => {
      try { db.ensureIndex(opts, () => {}); } catch(e) {}
    }
  };
}

const customers = wrap(customersDb);
const vehicles = wrap(vehiclesDb);
const services = wrap(servicesDb);
const appointments = wrap(appointmentsDb);

// cria alguns índices básicos (silenciosos)
customers.ensureIndex({ fieldName: 'created_at' });
vehicles.ensureIndex({ fieldName: 'customer_id' });
vehicles.ensureIndex({ fieldName: 'created_at' });
services.ensureIndex({ fieldName: 'created_at' });
appointments.ensureIndex({ fieldName: 'vehicle_id' });
appointments.ensureIndex({ fieldName: 'scheduled_at' });

module.exports = {
  customers,
  vehicles,
  services,
  appointments
};