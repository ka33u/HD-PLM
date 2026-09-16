#!/bin/sh
set -eu
node dist/setup.mjs
exec node dist/server.mjs
