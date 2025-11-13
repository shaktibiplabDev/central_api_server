// synchronize.js
const { pool } = require('../config/database');
const DB_SCHEMA = require('./schema');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function tableExists(tableName) {
    const [rows] = await pool.query("SHOW TABLES LIKE ?", [tableName]);
    return rows && rows.length > 0;
}

async function columnExists(tableName, columnName) {
    const [rows] = await pool.query("SHOW COLUMNS FROM `" + tableName + "` LIKE ?", [columnName]);
    return rows && rows.length > 0;
}

async function indexExists(tableName, indexName) {
    const [rows] = await pool.query("SHOW INDEX FROM `" + tableName + "` WHERE Key_name = ?", [indexName]);
    return rows && rows.length > 0;
}

async function fkExists(tableName, fkName) {
    const [rows] = await pool.query(
        `SELECT CONSTRAINT_NAME FROM information_schema.TABLE_CONSTRAINTS 
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY'`,
        [tableName, fkName]
    );
    return rows && rows.length > 0;
}

const createTableSQL = (tableName, tableDef) => {
    // join column definitions into a single table create statement
    const cols = tableDef.columns.map(c => `${c.name} ${c.def}`).join(',\n  ');
    return `CREATE TABLE \`${tableName}\` (\n  ${cols}\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;`;
};

const sync = async () => {
    console.log('Running database schema synchronization...');
    try {
        // Build list of existing tables once
        const [existing] = await pool.query('SHOW TABLES');
        const existingTables = existing.map(r => Object.values(r)[0]);

        // Ensure each table in creationOrder
        for (const tableName of DB_SCHEMA.creationOrder) {
            const tableDef = DB_SCHEMA.tables[tableName];
            if (!tableDef) {
                console.warn(`Schema missing definition for table '${tableName}', skipping.`);
                continue;
            }

            const exists = existingTables.includes(tableName) || await tableExists(tableName);
            if (!exists) {
                console.log(`Table '${tableName}' not found. Creating...`);
                const createSQL = createTableSQL(tableName, tableDef);
                await pool.query(createSQL);
                console.log(`✅ Created table '${tableName}'.`);
            } else {
                console.log(`Table '${tableName}' already exists — verifying columns...`);
            }

            // Ensure each column exists
            for (const col of tableDef.columns) {
                const colExists = await columnExists(tableName, col.name);
                if (!colExists) {
                    console.log(`-> Column '${col.name}' missing on '${tableName}', adding...`);
                    const alter = `ALTER TABLE \`${tableName}\` ADD COLUMN ${col.name} ${col.def}`;
                    try {
                        await pool.query(alter);
                        console.log(`   ✅ Added column ${col.name} to ${tableName}`);
                    } catch (err) {
                        console.error(`   ❌ Failed to add column ${col.name} to ${tableName}:`, err.message);
                        // continue trying other columns
                    }
                }
            }

            // Ensure indexes if provided
            if (tableDef.indexes && Array.isArray(tableDef.indexes)) {
                for (const idx of tableDef.indexes) {
                    const idxName = idx.name;
                    const existsIdx = await indexExists(tableName, idxName);
                    if (!existsIdx) {
                        const colsSql = idx.columns.map(c => `\`${c}\``).join(', ');
                        const indexType = (idx.type && idx.type.toUpperCase() === 'UNIQUE') ? 'UNIQUE KEY' : (idx.type && idx.type.toUpperCase() === 'PRIMARY') ? 'PRIMARY KEY' : 'KEY';
                        const sql = (indexType === 'PRIMARY KEY')
                            ? `ALTER TABLE \`${tableName}\` ADD PRIMARY KEY (${colsSql})`
                            : `ALTER TABLE \`${tableName}\` ADD ${indexType} \`${idxName}\` (${colsSql})`;
                        try {
                            await pool.query(sql);
                            console.log(`   ✅ Added index '${idxName}' on '${tableName}'`);
                        } catch (err) {
                            console.error(`   ❌ Failed to add index '${idxName}' on '${tableName}':`, err.message);
                        }
                    }
                }
            }

            // Ensure foreign keys if provided
            if (tableDef.fks && Array.isArray(tableDef.fks)) {
                for (const fk of tableDef.fks) {
                    const fkName = fk.name;
                    const existsFk = await fkExists(tableName, fkName);
                    if (!existsFk) {
                        // Ensure referenced table/column exist before adding FK
                        const refExists = await tableExists(fk.refTable);
                        const refColExists = refExists ? await columnExists(fk.refTable, fk.refColumn) : false;
                        if (!refExists || !refColExists) {
                            console.warn(`   ⚠️ Can't add FK '${fkName}' on '${tableName}' because referenced ${fk.refTable}.${fk.refColumn} does not exist yet.`);
                            continue;
                        }

                        const onDelete = fk.onDelete ? ` ON DELETE ${fk.onDelete}` : '';
                        const sql = `ALTER TABLE \`${tableName}\` ADD CONSTRAINT \`${fkName}\` FOREIGN KEY (\`${fk.column}\`) REFERENCES \`${fk.refTable}\`(\`${fk.refColumn}\`)${onDelete}`;
                        try {
                            await pool.query(sql);
                            console.log(`   ✅ Added foreign key '${fkName}' on '${tableName}'`);
                        } catch (err) {
                            console.error(`   ❌ Failed to add foreign key '${fkName}' on '${tableName}':`, err.message);
                        }
                    }
                }
            }

            // Seed table if required and table was just created (or empty).
            if (tableDef.seed && Array.isArray(tableDef.seed) && tableDef.seed.length > 0) {
                // check row count
                const [countRows] = await pool.query(`SELECT COUNT(1) as c FROM \`${tableName}\``);
                const count = (countRows && countRows[0]) ? countRows[0].c : 0;
                if (count === 0) {
                    console.log(`Seeding table '${tableName}'...`);
                    for (const row of tableDef.seed) {
                        try {
                            await pool.query(`INSERT INTO \`${tableName}\` SET ?`, [row]);
                        } catch (err) {
                            console.error(`   ❌ Failed to insert seed into ${tableName}:`, err.message);
                        }
                    }
                    console.log(`   ✅ Seeded '${tableName}'.`);
                } else {
                    console.log(`   ℹ️ Table '${tableName}' not empty (rows=${count}), skipping seeds.`);
                }
            }
        } // end tables loop

        console.log('Ensuring some legacy user columns (compat helpers)...');
        await ensureUserColumns();

        console.log('Database synchronization complete.');
    } catch (error) {
        console.error('❌ FATAL: Could not synchronize database schema.', error);
        process.exit(1);
    }
};

async function ensureUserColumns() {
    // check if users table exists first
    const [tables] = await pool.query("SHOW TABLES LIKE 'users'");
    if (!tables || tables.length === 0) return;

    // helper to check if a column exists
    async function hasColumn(col) {
        const [rows] = await pool.query("SHOW COLUMNS FROM users LIKE ?", [col]);
        return rows && rows.length > 0;
    }

    // columns we want to ensure (backwards compat)
    const extras = [
        { name: 'subscription_until', def: 'DATETIME DEFAULT NULL' },
        { name: 'license_status', def: "ENUM('active','inactive','suspended','expired','reissued') DEFAULT 'inactive'" },
        { name: 'license_key', def: 'VARCHAR(255) DEFAULT NULL' },
        { name: 'phone', def: 'VARCHAR(50) DEFAULT NULL' }
    ];

    for (const c of extras) {
        if (!(await hasColumn(c.name))) {
            try {
                console.log(`Adding column '${c.name}' to users...`);
                await pool.query(`ALTER TABLE users ADD COLUMN ${c.name} ${c.def}`);
                console.log(`-> added ${c.name}`);
            } catch (err) {
                console.error(`-> failed to add ${c.name}:`, err.message);
            }
        }
    }
}

module.exports = sync;

// If this file is run directly, perform synchronization
if (require.main === module) {
    (async () => {
        await sync();
        // small delay to ensure logs flush
        await sleep(200);
        process.exit(0);
    })();
}
