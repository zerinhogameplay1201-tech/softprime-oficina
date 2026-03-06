const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const { customers, vehicles, services, appointments } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// Home
app.get('/', async (req, res) => {
  const totalCustomers = (await customers.count({})) || 0;
  const totalVehicles = (await vehicles.count({})) || 0;
  const totalAppointments = (await appointments.count({})) || 0;
  res.render('index', { totalCustomers, totalVehicles, totalAppointments });
});

// ----- Customers -----
app.get('/customers', async (req, res) => {
  const all = await customers.find({}).sort({ created_at: -1 });
  res.render('customers', { customers: all });
});

app.get('/customers/new', (req, res) => {
  res.render('new_customer');
});

app.post('/customers', async (req, res) => {
  const { name, phone, email, notes } = req.body;
  await customers.insert({ name, phone, email, notes, created_at: new Date() });
  res.redirect('/customers');
});

app.get('/customers/:id', async (req, res) => {
  const id = req.params.id;
  const customer = await customers.findOne({ _id: id });
  if (!customer) return res.status(404).send('Cliente não encontrado');
  const cvs = await vehicles.find({ customer_id: id }).sort({ created_at: -1 });
  res.render('customer_show', { customer, vehicles: cvs });
});

// ----- Vehicles -----
app.get('/vehicles', async (req, res) => {
  const vs = await vehicles.find({}).sort({ created_at: -1 });
  // join customer name
  const list = await Promise.all(vs.map(async v => {
    const c = await customers.findOne({ _id: v.customer_id });
    return { ...v, customer_name: c ? c.name : '—' };
  }));
  res.render('vehicles', { vehicles: list });
});

app.get('/vehicles/new', async (req, res) => {
  const cs = await customers.find({}).sort({ name: 1 });
  res.render('new_vehicle', { customers: cs });
});

app.post('/vehicles', async (req, res) => {
  const { customer_id, make, model, year, plate, vin, notes } = req.body;
  await vehicles.insert({
    customer_id,
    make,
    model,
    year: year ? Number(year) : null,
    plate,
    vin,
    notes,
    created_at: new Date()
  });
  res.redirect('/vehicles');
});

// ----- Services -----
app.get('/services', async (req, res) => {
  const all = await services.find({}).sort({ created_at: -1 });
  res.render('services', { services: all });
});

app.get('/services/new', (req, res) => {
  res.render('new_service');
});

app.post('/services', async (req, res) => {
  const { description, price } = req.body;
  await services.insert({ description, price: price ? Number(price) : 0, created_at: new Date() });
  res.redirect('/services');
});

// ----- Appointments -----
app.get('/appointments', async (req, res) => {
  const appts = await appointments.find({}).sort({ scheduled_at: -1 });
  const full = await Promise.all(appts.map(async a => {
    const v = await vehicles.findOne({ _id: a.vehicle_id });
    const s = a.service_id ? await services.findOne({ _id: a.service_id }) : null;
    const c = v ? await customers.findOne({ _id: v.customer_id }) : null;
    return {
      ...a,
      vehicle: v,
      make: v ? v.make : '',
      model: v ? v.model : '',
      plate: v ? v.plate : '',
      service_desc: s ? s.description : null,
      customer_name: c ? c.name : ''
    };
  }));
  res.render('appointments', { appts: full });
});

app.get('/appointments/new', async (req, res) => {
  const vs = await vehicles.find({}).sort({ created_at: -1 });
  const vehiclesWithOwners = await Promise.all(vs.map(async v => {
    const c = await customers.findOne({ _id: v.customer_id });
    return { ...v, customer_name: c ? c.name : '' };
  }));
  const ss = await services.find({}).sort({ description: 1 });
  res.render('new_appointment', { vehicles: vehiclesWithOwners, services: ss });
});

app.post('/appointments', async (req, res) => {
  const { vehicle_id, service_id, scheduled_at, notes } = req.body;
  await appointments.insert({
    vehicle_id,
    service_id: service_id || null,
    scheduled_at: scheduled_at ? new Date(scheduled_at) : null,
    notes,
    created_at: new Date(),
    status: 'agendado'
  });
  res.redirect('/appointments');
});

// Static fallback
app.use((req, res) => res.status(404).send('Página não encontrada'));

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});