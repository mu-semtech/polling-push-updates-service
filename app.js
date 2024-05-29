// see https://github.com/mu-semtech/mu-javascript-template for more info
import { app, errorHandler, uuid } from 'mu';
import bodyParser from 'body-parser';

// TODO: Ensure messages are cleared when clients don't connect.
// TODO: On connecting, check that the session-id has not changed for the given tab identifier

const clientMessageMap = {};
const clientAliveTimestamps = {};
const idSessionMap = {};
const clientConnectionTimeout = 5 * 60 * 1000;
const cleanupInterval = 30 * 1000;
const LOG_CLEANUP = true;

// Internal endpoint for internal testing
app.post('/push', function (req, res) {
  const id = req.query["id"];
  const message = req.body;

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
  const id = `http://services.semantic.works/push-messages/client-id/${uuid()}`;

  console.log({ idSessionMap, clientMessageMap, clientAliveTimestamps });
  console.log(req.get("mu-session-id"));


  clientAliveTimestamps[id] = new Date();
  clientMessageMap[id] = [];
  idSessionMap[id] = req.get("mu-session-id");

  res
    .status(200)
    .send({ type: 'push-update-connections', id, attributes: { id } });
});

// Well behaving clients may disconnect
app.post('/disconnect', function (req, res) {
  const id = req.query["id"];

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

app.post('/delta', bodyParser.json({ limit: '50mb' }), function(req, res) {
  try {
    // we only care about inserts
    console.log(`Got body ${JSON.stringify(req.body)}`);

    for (const changeSet of req.body) {
      const inserts = changeSet.inserts;
      const predicateMapping = {
        "http://mu.semte.ch/vocabularies/push/messageJSON": "message",
        "http://mu.semte.ch/vocabularies/push/target": "target"
      };

      // find inserts with the desired type
      const resourcesWithType = inserts.filter(
        ({ predicate, object }) => predicate.value == "http://www.w3.org/1999/02/22-rdf-syntax-ns#type"
          && object.type == "uri"
          && object.value == "http://mu.semte.ch/vocabularies/push/JSONPushMessage"
      );

      // capture message content
      const infoObjects = {};
      resourcesWithType.forEach(({ subject: { value } }) => infoObjects[value] = {});

      for (const { subject, predicate, object } of inserts) {
        if (infoObjects[subject.value]) {
          const key = predicateMapping[predicate.value];
          if (key) infoObjects[subject.value][key] = object.value;
        }
      }

      // add messages
      for (const messageUri in infoObjects) {
        const { message, target } = infoObjects[messageUri];
        console.log(`Handling  ${JSON.stringify({ message, target })}`);
        if (clientMessageMap[target]) {
          console.log(`Setting  ${JSON.stringify({ message, target })}`);
          clientMessageMap[target].push(JSON.parse(message));
        } else {
          console.log(`Target ${target} not found`);
        }
      }

      console.log({
        inserts: JSON.stringify(inserts),
        predicateMapping: JSON.stringify(predicateMapping),
        resourcesWithType: JSON.stringify(resourcesWithType),
        infoObjects: JSON.stringify(infoObjects)
      });
    }

    res
      .status(200)
      .send({ message: "Processed" });
  } catch (e) {
    console.error(`Something went wrong!`);
    console.error(e);
  }
});

app.get('/pull', function (req, res) {
  const id = req.query["id"];

  console.log({ idSessionMap, clientMessageMap, clientAliveTimestamps });
  console.log(req.get("mu-session-id"));

  if (idSessionMap[id] && idSessionMap[id] == req.get("mu-session-id")) {
    if( LOG_CLEANUP )
      console.log('no session for id ${id}');
    const messages = clientMessageMap[id];
    clientAliveTimestamps[id] = new Date();
    clientMessageMap[id] = [];
    res
      .status(200)
      .send({ messages });
  } else if (!idSessionMap[id]) {
    res
      .status(410)
      .send({ error: "Session expired" });
  } else {
    res
      .status(403)
      .send({ error: "Forbidden" });
  }
});

setInterval(() => {
  let ids = Object.keys(clientAliveTimestamps);
  let minLastSeenDate = new Date((new Date()).getTime() - clientConnectionTimeout);
  for (const id of ids) {
    if (clientAliveTimestamps[id] < minLastSeenDate) {
      if( LOG_CLEANUP )
        console.log(`Cleaning up id: ${id} mu-session-id: ${idSessionMap[id]} due to inactivity.`);

      delete clientAliveTimestamps[id];
      delete idSessionMap[id];
      delete clientMessageMap[id];
    }
  }
}, cleanupInterval);

app.use(errorHandler);
