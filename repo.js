'use strict';

const usePostgres = Boolean(process.env.DATABASE_URL || process.env.POSTGRES_URL);

module.exports = usePostgres ? require('./repo.postgres') : require('./repo.local');
