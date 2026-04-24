-- Created on first Postgres startup. Provides a dedicated test database
-- so vitest can wipe/recreate freely without touching dev data.
CREATE DATABASE iproofnow_test OWNER iproof;
