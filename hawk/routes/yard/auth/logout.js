'use strict';

var express = require('express');
var router = express.Router();
var auth = require('../../../modules/auth');


router.get('/logout', function (req, res) {
  global.logger.debug('Logout page visited');
  auth.logout(res);
  res.redirect('/');
});

module.exports = router;
