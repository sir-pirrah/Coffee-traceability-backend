-- Enables case-insensitive text comparison, used by User.email
-- (@db.Citext in schema.prisma) so "Farmer@x.com" and "farmer@x.com"
-- are treated as the same unique value without app-level lowercasing.
CREATE EXTENSION IF NOT EXISTS citext;

-- Useful for generating UUIDs server-side if ever needed outside Prisma
-- (Prisma itself generates UUIDs in the application layer by default).
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";