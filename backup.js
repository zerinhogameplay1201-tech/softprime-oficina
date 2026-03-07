const fs = require('fs');
const path = require('path');

const dataDir = path.join(__dirname, 'data');
const backupsDir = path.join(__dirname, 'backups');

if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir);

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const files = fs.readdirSync(dataDir).filter(f => f.endsWith('.db') || f.endsWith('.db-journal') || f.endsWith('.json'));

files.forEach(file => {
  const src = path.join(dataDir, file);
  const dest = path.join(backupsDir, `${file}.${timestamp}.bak`);
  fs.copyFileSync(src, dest);
  console.log(`Backup feito: ${dest}`);
});

console.log('Backup concluído.');