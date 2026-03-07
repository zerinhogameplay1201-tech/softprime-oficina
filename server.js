const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const session = require('express-session');
const { check, validationResult } = require('express-validator');
const PDFDocument = require('pdfkit');
const nodemailer = require('nodemailer');
const { customers, vehicles, services, appointments } = require('./db');

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

// ----- CUSTOMERS -----
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

// ----- VEHICLES -----
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

// ----- SERVICES -----
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

// ----- APPOINTMENTS -----
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
      customer_name: c ? c.name : '',
      customer_email: c ? c.email : ''
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
  // compute total price (service price + parts_cost) unless total_price provided
  let computedTotal = null;
  if (service_id) {
    const s = await services.findOne({ _id: service_id });
    if (s) computedTotal = (s.price || 0) + (s.parts_cost || 0);
  }
  const finalPrice = total_price ? Number(total_price) : (computedTotal !== null ? computedTotal : 0);
  await appointments.insert({
    vehicle_id,
    service_id: service_id || null,
    scheduled_at: scheduled_at ? new Date(scheduled_at) : null,
    notes,
    technician: technician || null,
    total_price: finalPrice,
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
  let computedTotal = null;
  if (service_id) {
    const s = await services.findOne({ _id: service_id });
    if (s) computedTotal = (s.price || 0) + (s.parts_cost || 0);
  }
  const finalPrice = total_price ? Number(total_price) : (computedTotal !== null ? computedTotal : 0);
  await appointments.update({ _id: id }, { $set: {
    vehicle_id,
    service_id: service_id || null,
    scheduled_at: scheduled_at ? new Date(scheduled_at) : null,
    notes,
    status: status || 'agendado',
    technician: technician || null,
    total_price: finalPrice
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

  const getPdfBuffer = () => new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text('Orçamento - Softprime Oficina', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Cliente: ${c ? c.name : '-'}`);
    doc.text(`Telefone: ${c ? c.phone : '-'}`);
    doc.text(`Email: ${c ? c.email : '-'}`);
    if (c && c.address) doc.text(`Endereço: ${c.address}`);
    doc.moveDown();
    doc.text(`Veículo: ${v ? `${v.make} ${v.model} (${v.plate})` : '-'}`);
    if (v) {
      doc.text(`Cor: ${v.color || '-' }  Quilometragem: ${v.mileage || '-'}`);
    }
    doc.moveDown();
    doc.text(`Serviço: ${s ? s.description : '-'}`);
    if (s) {
      doc.text(`Duração estimada: ${s.duration || '-'} h`);
      doc.text(`Custo peças: R$ ${(s.parts_cost||0).toFixed(2)}`);
    }
    doc.moveDown();
    doc.fontSize(14).text(`Preço total: R$ ${(a.total_price || 0).toFixed(2)}`);
    doc.moveDown();
    doc.text(`Técnico: ${a.technician || '-'}`);
    doc.moveDown();
    doc.text(`Data agendada: ${a.scheduled_at ? new Date(a.scheduled_at).toLocaleString() : '-'}`);
    doc.moveDown();
    doc.text('Observações:');
    doc.text(a.notes || '-');

    doc.end();
  });

  const buffer = await getPdfBuffer();
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename=orcamento-${id}.pdf`);
  res.send(buffer);
});

// Envia orçamento por email (PDF em anexo)
app.post('/appointments/:id/email', ensureAuth, async (req, res) => {
  const id = req.params.id;
  const to = req.body.to || req.body.email || null;
  const a = await appointments.findOne({ _id: id });
  if (!a) return res.status(404).send('Agendamento não encontrado');
  const v = await vehicles.findOne({ _id: a.vehicle_id });
  const s = a.service_id ? await services.findOne({ _id: a.service_id }) : null;
  const c = v ? await customers.findOne({ _id: v.customer_id }) : null;

  const getPdfBuffer = () => new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(20).text('Orçamento - Softprime Oficina', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`Cliente: ${c ? c.name : '-'}`);
    doc.text(`Telefone: ${c ? c.phone : '-'}`);
    doc.text(`Email: ${c ? c.email : '-'}`);
    if (c && c.address) doc.text(`Endereço: ${c.address}`);
    doc.moveDown();
    doc.text(`Veículo: ${v ? `${v.make} ${v.model} (${v.plate})` : '-'}`);
    if (v) {
      doc.text(`Cor: ${v.color || '-' }  Quilometragem: ${v.mileage || '-'}`);
    }
    doc.moveDown();
    doc.text(`Serviço: ${s ? s.description : '-'}`);
    if (s) {
      doc.text(`Duração estimada: ${s.duration || '-'} h`);
      doc.text(`Custo peças: R$ ${(s.parts_cost||0).toFixed(2)}`);
    }
    doc.moveDown();
    doc.fontSize(14).text(`Preço total: R$ ${(a.total_price || 0).toFixed(2)}`);
    doc.moveDown();
    doc.text(`Técnico: ${a.technician || '-'}`);
    doc.moveDown();
    doc.text(`Data agendada: ${a.scheduled_at ? new Date(a.scheduled_at).toLocaleString() : '-'}`);
    doc.moveDown();
    doc.text('Observações:');
    doc.text(a.notes || '-');

    doc.end();
  });

  const buffer = await getPdfBuffer();

  // transporter via environment variables
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT;
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpSecure = (process.env.SMTP_SECURE === 'true');
  const emailFrom = process.env.EMAIL_FROM || (process.env.SMTP_USER || 'noreply@example.com');

  if (!smtpHost || !smtpPort || !smtpUser || !smtpPass) {
    return res.status(500).send('SMTP não configurado. Defina SMTP_HOST, SMTP_PORT, SMTP_USER e SMTP_PASS nas variáveis de ambiente.');
  }

  const transporter = nodemailer.createTransport({
    host: smtpHost,
    port: Number(smtpPort),
    secure: smtpSecure,
    auth: {
      user: smtpUser,
      pass: smtpPass
    }
  });

  const recipient = to || (c && c.email) || null;
  if (!recipient) return res.status(400).send('Nenhum destinatário de email informado.');

  try {
    await transporter.sendMail({
      from: emailFrom,
      to: recipient,
      subject: `Orçamento - Softprime Oficina (#${id})`,
      text: `Segue em anexo o orçamento para o agendamento ${id}.`,
      attachments: [
        { filename: `orcamento-${id}.pdf`, content: buffer }
      ]
    });
    res.redirect('/appointments');
  } catch (err) {
    console.error('Erro ao enviar email:', err);
    res.status(500).send('Erro ao enviar email: ' + err.message);
  }
});

// Static fallback
app.use((req, res) => res.status(404).send('Página não encontrada'));

app.listen(PORT, () => {
  console.log(`Servidor rodando em http://localhost:${PORT}`);
});