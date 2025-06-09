import { app, update, errorHandler, uuid, sparqlEscapeString, sparqlEscapeUri } from 'mu';
import bodyParser from "body-parser";

app.use(bodyParser.json());

/**
 * Stores the messages to be sent for each tab
 *
 * TODO: clear out inactive tabs
 */
const tabs = {};
// Amount of milliseconds to wait after a Push has received before sending the information to a client
const EXTRA_WAIT = 100;
const CONNECTION_HANGING_TIME = 30000;

class Tab {
  messages = [];
  uri;
  // @type NodeJS.Timeout?
  timeout;
  res;

  constructor( uri ) {
    this.uri = uri;
    this.reset();
  }

  reset() {
    this.messages = [];
    this.res = null;
    this.timeout = null;
  }

  add( messages ) {
    this.messages = [...this.messages, ...messages];
    this.triggerUpdate();
  }

  registerResponseObject( res ) {
    if( this.timeout )
      this.clearTimeout();
    this.res = res;
    if ( this.messages.length )
      this.transmit();
    else
      this.timeout = setTimeout( () => this.transmit(), CONNECTION_HANGING_TIME );
  }

  triggerUpdate() {
    if( this.timeout )
      this.clearTimeout();
    this.timeout = setTimeout( () => this.transmit(), EXTRA_WAIT );
  }

  transmit() {
    if( this.res ) {
      this.res
        .status(200)
        .send(JSON.stringify( {
          data:
            this.messages.map( (message) => ({
              type: "push-updates",
              id: uuid(),
              attributes: {
                content: message.content,
                channel: message.channel
              }}) )
      }));
      this.reset();
    }
  }

  clearTimeout() {
    if( this.timeout ) {
      try { this.timeout.close(); }
      catch (e) { console.warn( `${this.uri} had failing timeout closure.`) }
      this.timeout = null;
    }
  }
}

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
  const tabUri = req.query.tab;
  tabs[tabUri] ||= new Tab(tabUri);
  let tab = tabs[tabUri];
  tab.res = res;
  tab.registerResponseObject(res);
});

app.post('/delta', async (req, res) => {
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
      let tabUri, message, channel;
      for (let quad of quads) {
        switch (quad.predicate.value) {
          case "http://mu.semte.ch/vocabularies/push/target":
            tabUri = quad.object.value;
            break;
          case "http://mu.semte.ch/vocabularies/push/channel":
            channel = quad.object.value;
            break;
          // This format is far too simplistic.  We should be able to send linked data across instead.
          case "http://mu.semte.ch/vocabularies/push/message":
            message = quad.object.value;
            break;
        }
      }
    tabs[tabUri] ||= new Tab(tabUri);
    tabs[tabUri].add([{content: message,channel}]);
  });

  res.status(204).send();
});

app.get('/', function( req, res ) {
  res.send('Hello mu-javascript-template');
} );

app.use(errorHandler);
