#!/bin/bash
PG_USER="user"
PG_DB="inventory_db"
echo "Monitoring locks..."
while true; do
  echo "--- Active Locks at $(date) ---"
  # This needs to run inside the db container (or the host if `psql` is available and mapped)
  docker exec -it database-db-1 psql -U $PG_USER -d $PG_DB -c "SELECT relation::regclass, locktype, mode, granted FROM pg_locks WHERE NOT pid = pg_backend_pid();"
  sleep 2
done
