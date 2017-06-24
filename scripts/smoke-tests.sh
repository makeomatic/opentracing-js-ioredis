#!/bin/bash

set -e

IOREDIS_VERSION=$(cat node_modules/ioredis/package.json | node_modules/.bin/json version)

# checkout ioredis source
rm -rf ./ioredis
git clone https://github.com/luin/ioredis.git
cd ioredis
git checkout v${IOREDIS_VERSION}

# install all deps
npm i
# install our module
cat ../index.smoke.js >> test/helpers/global.js
npm test $(find ./test -name '*.js' -not -name 'exports.js')
