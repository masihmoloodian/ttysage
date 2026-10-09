#!/bin/sh
# Recreate the demo DB with a v1 migration and 3 rows, then switch the schema to v2.
set -e
rm -rf prisma/migrations dev.db prisma/dev.db
cp schema.v1.prisma prisma/schema.prisma
npx prisma migrate dev --name init </dev/null
sqlite3 dev.db "insert into User (name, legacyEmail) values ('Ada','ada@old'),('Linus','linus@old'),('Grace','grace@old');"
cp schema.v2.prisma prisma/schema.prisma
echo 'Demo DB ready. Run: ttysage run "npx prisma migrate dev"'
