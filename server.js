const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const { check, validationResult } = require('express-validator');
const PDFDocument = require('pdfkit');
const fs = require('fs');
const { customers, vehicles, services, appointments } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// simples credenciais (troque para variáveis de ambiente em produção)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'secret';

// views / ejs
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// habilita express-ejs-layouts (opcional, usamos partials mas mantemos)
// app.use(expressLayouts);
// app.set('layout', 'layout');

// middlewares
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'troque_para_algo_secreto',
  resave: false,
  saveUninitialized: false,
}));

// helper de autenticação
function ensureAuth(req, res, next) {
  if (req.session && req.session.user === ADMIN_USER) return next();
  return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
}

// expose auth info to views
app.use((req, res, next) => {
  res.locals.currentUser = req.session && req.session.user;
  next();
});

// ---- Auth routes ----
app.get('/login', (req, res) => {
  res.render('login', { error: null, next: req.query.next || '/' });
});

app.post('/login', (req, res) => {
  const { user, pass, next } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    req.session.user = ADMIN_USER;
    return res.redirect(next || '/');
  }
  res.render('login', { error: 'Usuário ou senha inválidos', next: next || '/' });
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---- Home ----
app.get('/', async (req, res) => {
  const totalCustomers = (await customers.count({})) || 0;
  const totalVehicles = (await vehicles.count({})) || 0;
  const totalAppointments = (await appointments.count({})) || 0;
  res.render('index', { totalCustomers, totalVehicles, totalAppointments });
});

// ---- Utilities: search + paginate in-memory (ok para MVP) ----
function applySearchAndPagination(list = [], q, page = 1, limit = 20, fields = []) {
  let filtered = list;
  if (q) {
    const qq = q.toLowerCase();
    filtered = list.filter(item => {
      return fields.some(f => {
        const v = (item[f] || '').toString().toLowerCase();
        return v.includes(qq);
      });
    });
  }
  const total = filtered.length;
  page = Number(page) || 1;
  limit = Number(limit) || 20;
  const start = (page - 1) * limit;
  const paged = filtered.slice(start, start + limit);
  return { data: paged, total, page, limit, pages: Math.ceil(total / limit) };
}

// ----- CUSTOMERS (existing + edit/delete already added earlier) -----
// GET /customers (list with search/pagination)
app.get('/customers', async (req, res) => {
  const q = req.query.q || '';
  const page = req.query.page || 1;
  const limit = req.query.limit || 20;
  const all = await customers.find({}).sort({ created_at: -1 });
  const result = applySearchAndPagination(all, q, page, limit, ['name', 'phone', 'email']);
  res.render('customers', { customers: result.data, q, pagination: { total: result.total, page: result.page, pages: result.pages, limit: result.limit } });
});

// other customer routes (create, show, new, edit, update, delete) kept as before:
app.get('/customers/new', ensureAuth, (req, res) => {
  res.render('new_customer');
});

app.post('/customers',
  ensureAuth,
  [ check('name').notEmpty().withMessage('Nome obrigatório') ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.render('new_customer', { errors: errors.array() });
    const { name, phone, email, notes } = req.body;
    await customers.insert({ name, phone, email, notes, created_at: new Date() });
    res.redirect('/customers');
  }
);

app.get('/customers/:id', async (req, res) => {
  const id = req.params.id;
  const customer = await customers.findOne({ _id: id });
  if (!customer) return res.status(404).send('Cliente não encontrado');
  const cvs = await vehicles.find({ customer_id: id }).sort({ created_at: -1 });
  res.render('customer_show', { customer, vehicles: cvs });
});

app.get('/customers/:id/edit', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const customer = await customers.findOne({ _id: id });
  if (!customer) return res.status(404).send('Cliente não encontrado');
  res.render('edit_customer', { customer });
});

app.post('/customers/:id/update', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const { name, phone, email, notes } = req.body;
  await customers.update({ _id: id }, { $set: { name, phone, email, notes } }, {});
  res.redirect('/customers/' + id);
});

app.post('/customers/:id/delete', ensureAuth, async (req, res) => {
  const id = req.params.id;
  await customers.remove({ _id: id }, {});
  res.redirect('/customers');
});

// ----- VEHICLES (CRUD + search/pagination) -----
app.get('/vehicles', async (req, res) => {
  const q = req.query.q || '';
  const page = req.query.page || 1;
  const limit = req.query.limit || 20;
  const vs = await vehicles.find({}).sort({ created_at: -1 });
  const list = await Promise.all(vs.map(async v => {
    const c = await customers.findOne({ _id: v.customer_id });
    return { ...v, customer_name: c ? c.name : '—' };
  }));
  const result = applySearchAndPagination(list, q, page, limit, ['plate', 'make', 'model', 'customer_name']);
  res.render('vehicles', { vehicles: result.data, q, pagination: { total: result.total, page: result.page, pages: result.pages, limit: result.limit } });
});

app.get('/vehicles/new', ensureAuth, async (req, res) => {
  const cs = await customers.find({}).sort({ name: 1 });
  res.render('new_vehicle', { customers: cs });
});

app.post('/vehicles', ensureAuth, [
  check('customer_id').notEmpty().withMessage('Cliente obrigatório'),
  check('year').optional({ checkFalsy: true }).isInt().withMessage('Ano inválido')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const cs = await customers.find({}).sort({ name: 1 });
    return res.render('new_vehicle', { customers: cs, errors: errors.array() });
  }
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

app.get('/vehicles/:id/edit', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const v = await vehicles.findOne({ _id: id });
  if (!v) return res.status(404).send('Veículo não encontrado');
  const cs = await customers.find({}).sort({ name: 1 });
  res.render('edit_vehicle', { vehicle: v, customers: cs });
});

app.post('/vehicles/:id/update', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const { customer_id, make, model, year, plate, vin, notes } = req.body;
  await vehicles.update({ _id: id }, { $set: { customer_id, make, model, year: year ? Number(year) : null, plate, vin, notes } }, {});
  res.redirect('/vehicles');
});

app.post('/vehicles/:id/delete', ensureAuth, async (req, res) => {
  const id = req.params.id;
  await vehicles.remove({ _id: id }, {});
  res.redirect('/vehicles');
});

// ----- SERVICES (CRUD + search/pagination) -----
app.get('/services', async (req, res) => {
  const q = req.query.q || '';
  const page = req.query.page || 1;
  const limit = req.query.limit || 20;
  const all = await services.find({}).sort({ created_at: -1 });
  const result = applySearchAndPagination(all, q, page, limit, ['description']);
  res.render('services', { services: result.data, q, pagination: { total: result.total, page: result.page, pages: result.pages, limit: result.limit } });
});

app.get('/services/new', ensureAuth, (req, res) => {
  res.render('new_service');
});

app.post('/services', ensureAuth, [
  check('description').notEmpty().withMessage('Descrição obrigatória'),
  check('price').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Preço inválido')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.render('new_service', { errors: errors.array() });
  const { description, price } = req.body;
  await services.insert({ description, price: price ? Number(price) : 0, created_at: new Date() });
  res.redirect('/services');
});

app.get('/services/:id/edit', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const s = await services.findOne({ _id: id });
  if (!s) return res.status(404).send('Serviço não encontrado');
  res.render('edit_service', { service: s });
});

app.post('/services/:id/update', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const { description, price } = req.body;
  await services.update({ _id: id }, { $set: { description, price: price ? Number(price) : 0 } }, {});
  res.redirect('/services');
});

app.post('/services/:id/delete', ensureAuth, async (req, res) => {
  const id = req.params.id;
  await services.remove({ _id: id }, {});
  res.redirect('/services');
});

// ----- APPOINTMENTS (CRUD + search/pagination + PDF) -----
app.get('/appointments', async (req, res) => {
  const q = req.query.q || '';
  const page = req.query.page || 1;
  const limit = req.query.limit || 20;
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
  const result = applySearchAndPagination(full, q, page, limit, ['make', 'model', 'plate', 'customer_name', 'service_desc', 'status']);
  res.render('appointments', { appts: result.data, q, pagination: { total: result.total, page: result.page, pages: result.pages, limit: result.limit } });
});

app.get('/appointments/new', ensureAuth, async (req, res) => {
  const vs = await vehicles.find({}).sort({ created_at: -1 });
  const vehiclesWithOwners = await Promise.all(vs.map(async v => {
    const c = await customers.findOne({ _id: v.customer_id });
    return { ...v, customer_name: c ? c.name : '' };
  }));
  const ss = await services.find({}).sort({ description: 1 });
  res.render('new_appointment', { vehicles: vehiclesWithOwners, services: ss });
});

app.post('/appointments', ensureAuth, [
  check('vehicle_id').notEmpty().withMessage('Veículo obrigatório')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const vs = await vehicles.find({}).sort({ created_at: -1 });
    const vehiclesWithOwners = await Promise.all(vs.map(async v => {
      const c = await customers.findOne({ _id: v.customer_id });
      return { ...v, customer_name: c ? c.name : '' };
    }));
    const ss = await services.find({}).sort({ description: 1 });
    return res.render('new_appointment', { vehicles: vehiclesWithOwners, services: ss, errors: errors.array() });
  }
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

app.get('/appointments/:id/edit', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const a = await appointments.findOne({ _id: id });
  if (!a) return res.status(404).send('Agendamento não encontrado');
  const vs = await vehicles.find({}).sort({ created_at: -1 });
  const vehiclesWithOwners = await Promise.all(vs.map(async v => {
    const c = await customers.findOne({ _id: v.customer_id });
    return { ...v, customer_name: c ? c.name : '' };
  }));
  const ss = await services.find({}).sort({ description: 1 });
  res.render('edit_appointment', { appt: a, vehicles: vehiclesWithOwners, services: ss });
});

app.post('/appointments/:id/update', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const { vehicle_id, service_id, scheduled_at, notes, status } = req.body;
  await appointments.update({ _id: id }, { $set: {
    vehicle_id,
    service_id: service_id || null,
    scheduled_at: scheduled_at ? new Date(scheduled_at) : null,
    notes,
    status: status || 'agendado'
  } }, {});
  res.redirect('/appointments');
});

app.post('/appointments/:id/delete', ensureAuth, async (req, res) => {
  const id = req.params.id;
  await appointments.remove({ _id: id }, {});
  res.redirect('/appointments');
});

// PDF: gera orçamento/recebível simples em PDF para um agendamento
app.get('/appointments/:id/estimate', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const a = await appointments.findOne({ _id: id });
  if (!a) return res.status(404).send('Agendamento não encontrado');
  const v = await vehicles.findOne({ _id: a.vehicle_id });
  const s = a.service_id ? await services.findOne({ _id: a.service_id }) : null;
  const c = v ? await customers.findOne({ _id: v.customer_id }) : null;

  // cria PDF
  const doc = new PDFDocument({ size: 'A4', margin: 50 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=orcamento-${id}.pdf`);
  doc.fontSize(20).text('Orçamento - Softprime Oficina', { align: 'center' });
  doc.moveDown();
  doc.fontSize(12).text(`Cliente: ${c ? c.name : '-'}`);
  doc.text(`Telefone: ${c ? c.phone : '-'}`);
  doc.text(`Email: ${c ? c.email : '-'}`);
  doc.moveDown();
  doc.text(`Veículo: ${v ? `${v.make} ${v.model} (${v.plate})` : '-'}`);
  doc.text(`Serviço: ${s ? s.description : '-'}`);
  doc.text(`Preço: R$ ${s ? (s.price||0).toFixed(2) : '0.00'}`);
  doc.moveDown();
  doc.text(`Data agendada: ${a.scheduled_at ? new Date(a.scheduled_at).toLocaleString() : '-'}`);
  doc.moveDown();
  doc.text('Observações:');
  doc.text(a.notes || '-');
  doc.end();
  doc.pipe(res);
});

// Static fallback
app.use((req, res) => res.status(404).send('Página não encontrada'));

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});