let express  = require('express');
let router = express.Router();
let events   = require('../../models/events');
let websites = require('../../models/websites');
let user = require('../../models/user');
let notifies = require('../../models/notifies');
let Crypto = require('crypto');

let md5 = function (input) {

  return Crypto.createHash('md5').update(input, 'utf8').digest('hex');

};


let getPythonErrors = function (req, res) {

  let response = req.body,
      location = response.errorLocation.file + ':' + response.errorLocation.line,
      host = response.domain;

  let event = {
    type          : 'python',
    tag           : 'fatal',
    token         : response.token,
    message       : response.message,
    errorLocation : response.errorLocation,
    stack         : response.stack,
    groupHash     : md5(location),
    time          : response.time
  };

  websites.get(event.token, host)
    .then( function (site) {

      if (!site) {

        res.sendStatus(403);
        return;

      }
      return user.get(site.user)
        .then(function (foundUser) {

          notifies.send(foundUser, host, event);

          events.add(host, event)
            .then(function () {

              res.sendStatus(200);

            })
            .catch(function (e) {

              console.log('Can not add event because of ', e);
              res.sendStatus(500);

            });

        });


    })
    .catch( function () {

      res.sendStatus(500);

    });

};

/* GET python errors. */
router.post('/python', getPythonErrors);

module.exports = router;
