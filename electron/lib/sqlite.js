// SQLite-Dateien lesen (GOG Galaxy, Amazon Games) – mit sql.js,
// also ohne natives Modul, das extra kompiliert werden müsste.
// Die Datei wird nur gelesen, nie verändert.
const fs = require('fs');

let SQL = null;
async function engine() {
  if (!SQL) SQL = await require('sql.js')();
  return SQL;
}

/** Öffnet eine Kopie der Datenbank im Speicher. null, wenn die Datei fehlt. */
async function openDb(file) {
  let data;
  try { data = await fs.promises.readFile(file); } catch { return null; }
  const S = await engine();
  const db = new S.Database(data);

  return {
    /** SELECT ausführen, Ergebnis als Liste von Objekten. */
    all(sql, params = []) {
      const stmt = db.prepare(sql);
      try {
        stmt.bind(params);
        const rows = [];
        while (stmt.step()) rows.push(stmt.getAsObject());
        return rows;
      } finally {
        stmt.free();
      }
    },
    tables() {
      return new Set(this.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    },
    columns(table) {
      return new Set(this.all(`PRAGMA table_info("${table.replace(/"/g, '')}")`).map((r) => r.name));
    },
    close() { db.close(); }
  };
}

module.exports = { openDb };
