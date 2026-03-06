const Datastore = require('nedb-promises');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir);

// Datastores
const customers = Datastore.create({ filename: path.join(dataDir, 'customers.db'), autoload: true });
const vehicles = Datastore.create({ filename: path.join(dataDir, 'vehicles.db'), autoload: true });
const services = Datastore.create({ filename: path.join(dataDir, 'services.db'), autoload: true });
const appointments = Datastore.create({ filename: path.join(dataDir, 'appointments.db'), autoload: true });

// Ensure indexes for quick lookups / relations
(async () => {
  try {
    await customers.ensureIndex({ fieldName: 'created_at' });
    await vehicles.ensureIndex({ fieldName: 'customer_id' });
    await vehicles.ensureIndex({ fieldName: 'created_at' });
    await services.ensureIndex({ fieldName: 'created_at' });
    await appointments.ensureIndex({ fieldName: 'vehicle_id' });
    await appointments.ensureIndex({ fieldName: 'scheduled_at' });
  } catch (err) {
    // ignore index errors on repeated runs
  }
})();

module.exports = {
  customers,
  vehicles,
  services,
  appointments
};