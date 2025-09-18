const { pool } = require('../config/database');
const DB_SCHEMA = require('./schema');

const synchronizeDb = async () => {
    console.log('Running database schema synchronization...');
    try {
        const [existingTables] = await pool.query('SHOW TABLES');
        const existingTableNames = existingTables.map(t => Object.values(t)[0]);

        for (const tableName of DB_SCHEMA.creationOrder) {
            const table = DB_SCHEMA.tables[tableName];
            if (!table) continue;

            if (!existingTableNames.includes(tableName)) {
                console.log(`Table '${tableName}' not found. Creating...`);
                const createQuery = `CREATE TABLE ${tableName} (${table.columns})`;
                await pool.query(createQuery);
                console.log(`✅ Table '${tableName}' created.`);

                if (table.seed && table.seed.length > 0) {
                    console.log(`Seeding data for '${tableName}'...`);
                    for (const seedData of table.seed) {
                        await pool.query(`INSERT INTO ${tableName} SET ?`, seedData);
                    }
                    console.log(`✅ Seed data for '${tableName}' inserted.`);
                }
            }
        }
        console.log('Database synchronization complete.');
    } catch (error) {
        console.error('❌ FATAL: Could not synchronize database schema.', error);
        process.exit(1);
    }
};

module.exports = synchronizeDb;