import { app, update, errorHandler, uuid, sparqlEscapeString, sparqlEscapeUri } from 'mu';
import bodyParser from "body-parser";

app.use(bodyParser.json());

/**
 * Stores the messages to be sent for each tab
 *
 * TODO: clear out inactive tabs
 */
const tabMessages = {};

app.get('/tabUri', async (req, res) => {
  // construct a new tabId
  const tabUuid = uuid();
  const tabUri = `http://services.redpencil.io/polling-push-updates/tab-ids/${tabUuid}`;
  const sessionId = req.get("mu-session-id");

  // associate the tabId with the current session
  await update(`
    PREFIX push: <http://mu.semte.ch/vocabularies/push/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    INSERT DATA {
      ${sparqlEscapeUri(tabUri)}
        a push:Tab;
        mu:uuid ${sparqlEscapeString(tabUuid)};
        rdf:label ${sparqlEscapeString(`User Agent Tab ${tabUuid}`)};
        push:session ${sparqlEscapeUri(sessionId)}.
     }`);
  // return the tabId
  res
    .status(200)
    .send(JSON.stringify({data: {attributes: { tabUri }} }));
});

app.get('/messages', async (req, res) => {
  const tab = req.query.tab;
  const messages = tabMessages[tab];
  console.log({messages});
  tabMessages[tab] = [];
  res
    .status(200)
    .send( JSON.stringify({data: { attributes: { messages: messages || [] } }}) );
});

app.post('/delta', async (req, res) => {
  console.log(req.body);
  // We look for anything that is a push:Update
  const quadsBySubject = {};
  const insertedQuads =
        req
        .body
        .map( (delta) => delta.inserts )
        .flat();

  // Make sure each interesting quadsBySubject has an empty array
  insertedQuads
    .filter( (quad) => quad.predicate.value === "http://www.w3.org/1999/02/22-rdf-syntax-ns#type" )
    .filter( (quad) => quad.object.value === "http://mu.semte.ch/vocabularies/push/Update" )
    .forEach( (quad) => quadsBySubject[quad.subject.value] = [] );

  // Fill in interesting quadsBySubject
  insertedQuads
    .filter( (quad) => Array.isArray(quadsBySubject[quad.subject.value]) )
    .forEach( (quad) => quadsBySubject[quad.subject.value].push(quad) );

  Object.entries(quadsBySubject)
    .forEach(([_subject, quads], _index) => {
      let tabUri, message;
      for (let quad of quads) {
        switch (quad.predicate.value) {
          case "http://mu.semte.ch/vocabularies/push/target":
            tabUri = quad.object.value;
            break;
          // This format is far too simplistic.  We should be able to send linked data across instead.
          case "http://mu.semte.ch/vocabularies/push/message":
            message = quad.object.value;
            break;
        }
      }
      tabMessages[tabUri] ||= [];
      tabMessages[tabUri].push(message);
  });

  console.log(JSON.stringify(tabMessages));
});

app.get('/', function( req, res ) {
  res.send('Hello mu-javascript-template');
} );

app.use(errorHandler);
