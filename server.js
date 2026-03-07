const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const { check, validationResult } = require('express-validator');
const PDFDocument = require('pdfkit');
const { customers, vehicles, services, appointments, parts, purchases, sales } = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// simples credenciais (troque para variáveis de ambiente em produção)
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'secret';

// views / ejs
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

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

// expose auth info and low-stock badge to views
app.use(async (req, res, next) => {
  res.locals.currentUser = req.session && req.session.user;
  try {
    const allParts = await parts.find({}).sort({ created_at: -1 });
    const lowCount = allParts.reduce((acc, p) => acc + ((p.quantity || 0) <= (p.min_stock || 0) ? 1 : 0), 0);
    res.locals.lowStockCount = lowCount;
  } catch (e) {
    res.locals.lowStockCount = 0;
  }
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

// Utilities: search + paginate in-memory (ok for MVP)
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

// ----- Customers -----
app.get('/customers', async (req, res) => {
  const q = req.query.q || '';
  const page = req.query.page || 1;
  const limit = req.query.limit || 20;
  const all = await customers.find({}).sort({ created_at: -1 });
  const result = applySearchAndPagination(all, q, page, limit, ['name', 'phone', 'email']);
  res.render('customers', { customers: result.data, q, pagination: { total: result.total, page: result.page, pages: result.pages, limit: result.limit } });
});

app.get('/customers/new', ensureAuth, (req, res) => {
  res.render('new_customer');
});

app.post('/customers',
  ensureAuth,
  [ check('name').notEmpty().withMessage('Nome obrigatório') ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.render('new_customer', { errors: errors.array() });
    const { name, phone, email, notes, address } = req.body;
    await customers.insert({ name, phone, email, notes, address, created_at: new Date() });
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
  const { name, phone, email, notes, address } = req.body;
  await customers.update({ _id: id }, { $set: { name, phone, email, notes, address } }, {});
  res.redirect('/customers/' + id);
});

app.post('/customers/:id/delete', ensureAuth, async (req, res) => {
  const id = req.params.id;
  await customers.remove({ _id: id }, {});
  res.redirect('/customers');
});

// ----- Vehicles -----
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
  const { customer_id, make, model, year, plate, vin, notes, color, mileage } = req.body;
  await vehicles.insert({
    customer_id,
    make,
    model,
    year: year ? Number(year) : null,
    plate,
    vin,
    notes,
    color: color || null,
    mileage: mileage ? Number(mileage) : null,
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
  const { customer_id, make, model, year, plate, vin, notes, color, mileage } = req.body;
  await vehicles.update({ _id: id }, { $set: { customer_id, make, model, year: year ? Number(year) : null, plate, vin, notes, color: color || null, mileage: mileage ? Number(mileage) : null } }, {});
  res.redirect('/vehicles');
});

app.post('/vehicles/:id/delete', ensureAuth, async (req, res) => {
  const id = req.params.id;
  await vehicles.remove({ _id: id }, {});
  res.redirect('/vehicles');
});

// ----- Services -----
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
  const { description, price, duration, parts_cost } = req.body;
  await services.insert({
    description,
    price: price ? Number(price) : 0,
    duration: duration ? Number(duration) : null,
    parts_cost: parts_cost ? Number(parts_cost) : 0,
    created_at: new Date()
  });
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
  const { description, price, duration, parts_cost } = req.body;
  await services.update({ _id: id }, { $set: { description, price: price ? Number(price) : 0, duration: duration ? Number(duration) : null, parts_cost: parts_cost ? Number(parts_cost) : 0 } }, {});
  res.redirect('/services');
});

app.post('/services/:id/delete', ensureAuth, async (req, res) => {
  const id = req.params.id;
  await services.remove({ _id: id }, {});
  res.redirect('/services');
});

// ----- Appointments -----
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
  const { vehicle_id, service_id, scheduled_at, notes, technician, total_price } = req.body;
  await appointments.insert({
    vehicle_id,
    service_id: service_id || null,
    scheduled_at: scheduled_at ? new Date(scheduled_at) : null,
    notes,
    technician: technician || null,
    total_price: total_price ? Number(total_price) : 0,
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
  const { vehicle_id, service_id, scheduled_at, notes, status, technician, total_price } = req.body;
  await appointments.update({ _id: id }, { $set: {
    vehicle_id,
    service_id: service_id || null,
    scheduled_at: scheduled_at ? new Date(scheduled_at) : null,
    notes,
    status: status || 'agendado',
    technician: technician || null,
    total_price: total_price ? Number(total_price) : 0
  } }, {});
  res.redirect('/appointments');
});

app.post('/appointments/:id/delete', ensureAuth, async (req, res) => {
  const id = req.params.id;
  await appointments.remove({ _id: id }, {});
  res.redirect('/appointments');
});

// NEW: appointment detail page (shows linked sales and button to add pieces)
app.get('/appointments/:id', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const a = await appointments.findOne({ _id: id });
  if (!a) return res.status(404).send('Agendamento não encontrado');
  const v = a.vehicle_id ? await vehicles.findOne({ _id: a.vehicle_id }) : null;
  const s = a.service_id ? await services.findOne({ _id: a.service_id }) : null;
  const c = v ? await customers.findOne({ _id: v.customer_id }) : null;

  // linked sales
  const linkedSales = await sales.find({ appointment_id: id }).sort({ created_at: -1 });
  const salesDetailed = await Promise.all((linkedSales || []).map(async sl => {
    const items = await Promise.all((sl.items || []).map(async it => {
      const p = await parts.findOne({ _id: it.part_id });
      return { ...it, part_name: p ? p.name : '—', sku: p ? p.sku : '' };
    }));
    return { ...sl, items };
  }));

  const partsTotal = salesDetailed.reduce((acc, sl) => acc + Number(sl.total || 0), 0);
  const servicePrice = s ? Number(s.price || 0) : 0;
  const computedTotal = (Number(a.total_price || 0) || servicePrice) + partsTotal;

  res.render('appointment_show', { appt: a, vehicle: v, service: s, customer: c, sales: salesDetailed, partsTotal, computedTotal });
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

// ----- Parts (Peças) -----
app.get('/parts', async (req, res) => {
  const q = req.query.q || '';
  const low = req.query.low === '1';
  const all = await parts.find({}).sort({ created_at: -1 });
  let filtered = all;
  if (low) filtered = all.filter(p => (p.quantity || 0) <= (p.min_stock || 0));
  if (q) filtered = filtered.filter(p => (p.name||'').toLowerCase().includes(q.toLowerCase()) || (p.sku||'').toLowerCase().includes(q.toLowerCase()));
  res.render('parts', { parts: filtered, q });
});

app.get('/parts/new', ensureAuth, (req, res) => {
  res.render('new_part');
});

app.post('/parts', ensureAuth, [
  check('name').notEmpty().withMessage('Nome obrigatório'),
  check('sell_price').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Preço inválido'),
  check('cost_price').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Custo inválido'),
  check('quantity').optional({ checkFalsy: true }).isInt().withMessage('Quantidade inválida'),
  check('min_stock').optional({ checkFalsy: true }).isInt().withMessage('Estoque mínimo inválido')
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.render('new_part', { errors: errors.array() });
  const { name, sku, cost_price, sell_price, quantity, min_stock } = req.body;
  await parts.insert({
    name,
    sku: sku || null,
    cost_price: cost_price ? Number(cost_price) : 0,
    sell_price: sell_price ? Number(sell_price) : 0,
    quantity: quantity ? Number(quantity) : 0,
    min_stock: min_stock ? Number(min_stock) : 0,
    created_at: new Date()
  });
  res.redirect('/parts');
});

app.get('/parts/:id/edit', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const p = await parts.findOne({ _id: id });
  if (!p) return res.status(404).send('Peça não encontrada');
  res.render('edit_part', { part: p });
});

app.post('/parts/:id/update', ensureAuth, [
  check('name').notEmpty().withMessage('Nome obrigatório'),
  check('sell_price').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Preço inválido'),
  check('cost_price').optional({ checkFalsy: true }).isFloat({ min: 0 }).withMessage('Custo inválido'),
  check('quantity').optional({ checkFalsy: true }).isInt().withMessage('Quantidade inválida'),
  check('min_stock').optional({ checkFalsy: true }).isInt().withMessage('Estoque mínimo inválido')
], async (req, res) => {
  const id = req.params.id;
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    const p = await parts.findOne({ _id: id });
    return res.render('edit_part', { part: p, errors: errors.array() });
  }
  const { name, sku, cost_price, sell_price, quantity, min_stock } = req.body;
  await parts.update({ _id: id }, { $set: {
    name,
    sku: sku || null,
    cost_price: cost_price ? Number(cost_price) : 0,
    sell_price: sell_price ? Number(sell_price) : 0,
    quantity: quantity ? Number(quantity) : 0,
    min_stock: min_stock ? Number(min_stock) : 0
  }}, {});
  res.redirect('/parts');
});

app.post('/parts/:id/delete', ensureAuth, async (req, res) => {
  const id = req.params.id;
  await parts.remove({ _id: id }, {});
  res.redirect('/parts');
});

// ----- Purchases -----
// (mantém suas rotas de purchases já implementadas)

app.get('/purchases', ensureAuth, async (req, res) => {
  const all = await purchases.find({}).sort({ created_at: -1 });
  res.render('purchases', { purchases: all });
});

app.get('/purchases/new', ensureAuth, async (req, res) => {
  const allParts = await parts.find({}).sort({ name: 1 });
  res.render('new_purchase', { parts: allParts });
});

app.post('/purchases', ensureAuth, async (req, res) => {
  const supplier = req.body.supplier || '';
  let { part_id, qty, unit_cost } = req.body;
  if (!Array.isArray(part_id)) part_id = part_id ? [part_id] : [];
  if (!Array.isArray(qty)) qty = qty ? [qty] : [];
  if (!Array.isArray(unit_cost)) unit_cost = unit_cost ? [unit_cost] : [];
  const items = [];
  for (let i = 0; i < part_id.length; i++) {
    const pid = part_id[i];
    const q = Number(qty[i] || 0);
    const uc = Number(unit_cost[i] || 0);
    if (!pid || q <= 0) continue;
    items.push({ part_id: pid, qty: q, unit_cost: uc });
  }
  if (items.length === 0) {
    const allParts = await parts.find({}).sort({ name: 1 });
    return res.render('new_purchase', { parts: allParts, error: 'Adicione ao menos um item com quantidade válida.' });
  }
  const total = items.reduce((s, it) => s + (it.qty * (it.unit_cost || 0)), 0);
  const purchase = await purchases.insert({ supplier, items, total, created_at: new Date() });
  for (const it of items) {
    const p = await parts.findOne({ _id: it.part_id });
    if (!p) continue;
    const oldQty = Number(p.quantity || 0);
    const oldCost = Number(p.cost_price || 0);
    const addQty = Number(it.qty || 0);
    const unitCost = Number(it.unit_cost || 0);
    const newQty = oldQty + addQty;
    const newCost = (oldQty * oldCost + addQty * unitCost) / (newQty || 1);
    await parts.update({ _id: it.part_id }, { $set: { quantity: newQty, cost_price: newCost } }, {});
  }
  res.redirect('/purchases/' + purchase._id);
});

app.get('/purchases/:id', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const p = await purchases.findOne({ _id: id });
  if (!p) return res.status(404).send('Compra não encontrada');
  const itemsDetailed = await Promise.all((p.items || []).map(async it => {
    const part = await parts.findOne({ _id: it.part_id });
    return { ...it, part_name: part ? part.name : '—', sku: part ? part.sku : '' };
  }));
  res.render('purchase_show', { purchase: p, items: itemsDetailed });
});

// ----- Sales (Vendas) -----
// List sales
app.get('/sales', ensureAuth, async (req, res) => {
  const all = await sales.find({}).sort({ created_at: -1 });
  res.render('sales', { sales: all });
});

// New sale form (improved: if appointment_id provided, include appointment details)
app.get('/sales/new', ensureAuth, async (req, res) => {
  const allParts = await parts.find({}).sort({ name: 1 });
  const appointment_id = req.query.appointment_id || '';
  let appointment = null;
  if (appointment_id) {
    appointment = await appointments.findOne({ _id: appointment_id });
    if (appointment) {
      const v = appointment.vehicle_id ? await vehicles.findOne({ _id: appointment.vehicle_id }) : null;
      const c = v ? await customers.findOne({ _id: v.customer_id }) : null;
      appointment._vehicle = v;
      appointment._customer = c;
    } else {
      // invalid appointment id: ignore
    }
  }
  res.render('new_sale', { parts: allParts, appointment_id, appointment, error: null });
});

// Create sale
app.post('/sales', ensureAuth, async (req, res) => {
  const { appointment_id, customer_name, notes } = req.body;
  let { part_id, qty, unit_price } = req.body;
  if (!Array.isArray(part_id)) part_id = part_id ? [part_id] : [];
  if (!Array.isArray(qty)) qty = qty ? [qty] : [];
  if (!Array.isArray(unit_price)) unit_price = unit_price ? [unit_price] : [];
  const items = [];
  for (let i = 0; i < part_id.length; i++) {
    const pid = part_id[i];
    const q = Number(qty[i] || 0);
    const up = Number(unit_price[i] || 0);
    if (!pid || q <= 0) continue;
    items.push({ part_id: pid, qty: q, unit_price: up });
  }
  if (items.length === 0) {
    const allParts = await parts.find({}).sort({ name: 1 });
    return res.render('new_sale', { parts: allParts, appointment_id: appointment_id || '', appointment: null, error: 'Adicione ao menos um item com quantidade válida.' });
  }
  // check stock availability
  for (const it of items) {
    const p = await parts.findOne({ _id: it.part_id });
    if (!p) {
      const allParts = await parts.find({}).sort({ name: 1 });
      return res.render('new_sale', { parts: allParts, appointment_id: appointment_id || '', appointment: null, error: `Peça não encontrada (id=${it.part_id}).` });
    }
    const available = Number(p.quantity || 0);
    if (it.qty > available) {
      const allParts = await parts.find({}).sort({ name: 1 });
      return res.render('new_sale', { parts: allParts, appointment_id: appointment_id || '', appointment: null, error: `Estoque insuficiente para "${p.name}". Disponível: ${available}, solicitado: ${it.qty}` });
    }
  }
  const total = items.reduce((s, it) => s + (it.qty * (it.unit_price || 0)), 0);
  const sale = await sales.insert({ appointment_id: appointment_id || null, customer_name: customer_name || null, items, total, notes: notes || null, created_at: new Date() });
  for (const it of items) {
    const p = await parts.findOne({ _id: it.part_id });
    if (!p) continue;
    const oldQty = Number(p.quantity || 0);
    const newQty = Math.max(0, oldQty - Number(it.qty || 0));
    await parts.update({ _id: it.part_id }, { $set: { quantity: newQty } }, {});
  }
  if (appointment_id) {
    const ap = await appointments.findOne({ _id: appointment_id });
    if (ap) {
      const prev = Number(ap.total_price || 0);
      await appointments.update({ _id: appointment_id }, { $set: { total_price: prev + total } }, {});
    }
  }
  res.redirect('/sales/' + sale._id);
});

// Show sale
app.get('/sales/:id', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const s = await sales.findOne({ _id: id });
  if (!s) return res.status(404).send('Venda não encontrada');
  const itemsDetailed = await Promise.all((s.items || []).map(async it => {
    const part = await parts.findOne({ _id: it.part_id });
    return { ...it, part_name: part ? part.name : '—', sku: part ? part.sku : '' };
  }));
  res.render('sale_show', { sale: s, items: itemsDetailed });
});

// Static fallback
app.use((req, res) => res.status(404).send('Página não encontrada'));

// start
app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});