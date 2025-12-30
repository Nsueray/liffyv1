const { Pool, types } = require('pg');

// BYTEA FIX: PostgreSQL bytea sütunlarını düzgün Buffer olarak al
// Type OID 17 = bytea
types.setTypeParser(17, function(val) {
  // val zaten Buffer olarak geliyor olabilir
  if (Buffer.isBuffer(val)) return val;
  
  // String olarak geldiyse (hex format: \x...)
  if (typeof val === 'string') {
    if (val.startsWith('\\x')) {
      return Buffer.from(val.slice(2), 'hex');
    }
    return Buffer.from(val, 'binary');
  }
  
  return val;
});

const connectionString = process.env.DATABASE_URL;

const pool = new Pool({
  connectionString,
  ssl: process.env.NODE_ENV === 'production' 
    ? { rejectUnauthorized: false } 
    : false,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.connect()
  .then(client => {
    console.log('Database connected successfully');
    client.release();
  })
  .catch(err => {
    console.error('Database connection error:', err.message);
  });

module.exports = pool;
