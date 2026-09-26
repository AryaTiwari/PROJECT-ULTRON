#!/usr/bin/env node
'use strict';
const control=require('../core/universal-enrichment-control-plane');
const result=control.health();
console.log(result.text);
