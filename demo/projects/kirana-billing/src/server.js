// DEMO ONLY: deliberately vulnerable code for testing Vulnexis. Never deploy or run on a network.
const express = require('express');
const invoices = require('./routes/invoices');
const auth = require('./routes/auth');
const supplier = require('./routes/supplier');
const admin = require('./routes/admin');
const requireOwner = require('./middleware/owner');

const app = express();
app.set('view engine', 'ejs');
app.use(express.json());

app.use('/invoices', invoices);
app.use('/auth', auth);
app.use('/supplier', supplier);
app.use('/admin', requireOwner, admin); // owner-only pages: a valid JWT is checked first

app.listen(3000, () => console.log('Kirana billing (demo) on :3000'));
