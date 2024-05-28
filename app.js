// see https://github.com/mu-semtech/mu-javascript-template for more info

import { app, errorHandler, uuid } from 'mu';

// TODO: Ensure messages are cleared when clients don't connect.
// TODO: On connecting, check that the session-id has not changed for the given tab identifier

const clientMessageMap = {};
const clientAliveTimestamps = {};
const idSessionMap = {};
const clientConnectionTimeout = 5 * 60 * 1000;
const cleanupInterval = 5000;
const LOG_CLEANUP = true;

// Internal endpoint for internal testing
app.post('/push', function (req, res) {
  const id = req.query["id"];
  const message = JSON.parse(req.body);

  if( clientMessageMap[id] ) {
    clientMessageMap[id].push(message);

    res
      .status(204)
      .send();
  } else {
    res
      .status(404)
      .send({"message": `client ${id} is unknown`});
  }
});

// Clients receive an id when they connect
app.post('/connect', function (req, res) {
  const id = uuid();

  clientAliveTimestamps[id] = new Date();
  clientMessageMap[id] = [];
  idSessionMap[id] = req.get("mu-session-id");

  res
    .status(200)
    .send({ type: 'push-update-connections', id, attributes: { id } });
});

// Well behaving clients may disconnect
app.post('/disconnect', function (req, res) {
  const id = uuid();

  if (idSessionMap[id] && idSessionMap[id] !== req.get("mu-session-id")) {
    res
      .status(403)
      .send({ error: "Forbidden" });
  } else {
    delete idSessionMap[id];
    delete clientMessageMap[id];
    delete clientAliveTimestamps[id];
    
    res
      .status(204)
      .send();
  }
});

app.post('/delta', function(req, res) {
  // we only care about inserts
  for( const changeSet of req.body ) {
    const inserts = changeSet.inserts;
    const predicateMapping = {
      "http://mu.semte.ch/vocabularies/delta/message": "message",
      "http://mu.semte.ch/vocabularies/delta/targetId": "target"
    };

    // find inserts with the desired type
    const resourcesWithType = inserts.filter(
      ({predicate}) => predicate.type = "uri" && predicate.value == "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
    );

    // capture message content
    const infoObjects = {};
    resourcesWithType.forEach( ({subject: {value}}) => infoObjects[value] = {} );

    for (const {subject, predicate, object} of inserts) {
      if( infoObjects[subject] ) {
        const key = predicateMapping[predicate.value];
        if( key ) infoObjects[subject][key] = object.value;
      }
    }

    // add messages
    for(const {message, target} in infoObjects) {
      if( clientMessageMap[target] ) {
        clientMessageMap[target].push(JSON.parse(message));
      }
    }
  }
});

app.get('/pull', function (req, res) {
  const id = req.query("id");

  if (idSessionMap[id] && idSessionMap[id] == req.get("mu-session-id")) {
    const messages = clientMessageMap[id];
    clientAliveTimestamps[id] = new Date();
    clientMessageMap[id] = [];
    res
      .status(200)
      .send({ messages });
  } else if (!idSessionMap[id]) {
    res
      .status(440)
      .send({ error: "Session expired" });
  } else {
    res
      .status(403)
      .send({ error: "Forbidden" });
  }
});

setTimeout(() => {
  let ids = Object.keys(clientAliveTimestamps);
  let maxDate = new Date((new Date()).getTime() + clientConnectionTimeout);
  for (const id of ids) {
    if (maxDate < clientAliveTimestamps[id]) {
      if( LOG_CLEANUP )
        console.log(`Cleaning up id: ${id} mu-session-id: ${idSessionMap[id]} due to inactivity.`);

      delete clientAliveTimestamps[id];
      delete idSessionMap[id];
      delete clientMessageMap[id];
    }
  }
}, cleanupInterval);

app.use(errorHandler);
