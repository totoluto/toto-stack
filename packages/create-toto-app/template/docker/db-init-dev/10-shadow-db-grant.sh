#!/bin/sh
# Development only (mounted by docker-compose.override.yml): allow the app
# user to create and drop the throwaway "shadow" databases that
# `prisma migrate dev` uses to detect schema drift. Prisma names them
# prisma_migrate_shadow_db_<uuid>. Production never needs this.
set -e
mariadb --protocol=socket -uroot -p"${MARIADB_ROOT_PASSWORD}" <<SQL
GRANT ALL PRIVILEGES ON \`prisma\\_migrate\\_shadow\\_db\\_%\`.* TO '${MARIADB_USER}'@'%';
SQL
