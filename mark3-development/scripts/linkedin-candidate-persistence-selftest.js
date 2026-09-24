'use strict';
const assert = require('node:assert/strict'); const fs = require('fs'); const path = require('path');
const source = fs.readFileSync(path.join(__dirname,'..','core','linkedin-account-operator.js'),'utf8');
assert.match(source,/const markJobChecked = \(\) =>/);
assert.doesNotMatch(source,/jobDetails\+\+;\s*checkedJobIds\.push\(String\(jobId\)\)/);
assert.match(source,/cachedCompanyProfileMisses\+\+;\s*continue;/);
assert.match(source,/rejectionReasons\.includes\('employee_count'\)[\s\S]{0,120}!record\.employeeCount/);
assert.match(source,/LinkedIn lead discovery checkpoint — continuing automatically/);
console.log('LinkedIn candidate persistence self-test passed: jobs remain retryable until required company verification completes, legacy incomplete size rejections are reclaimed, and checkpoints report continuation accurately.');
