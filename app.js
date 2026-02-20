import { app, update, errorHandler, uuid, sparqlEscapeString, sparqlEscapeUri } from 'mu';
import bodyParser from 'body-parser';

app.use(bodyParser.json());

/**
 * Stores the messages to be sent for each tab
 *
 * TODO: clear out inactive tabs and create push:Disconnect update for other services
 */
const tabs = {};
// Amount of milliseconds to wait after a Push has received before sending the information to a client
const EXTRA_WAIT = parseInt(process.env.EXTRA_WAIT || '100');
/**
 * @type {number} Amount of milliseconds we leave a connection hanging when we don't have data yet.
 */
const CONNECTION_HANGING_TIME = parseInt(process.env.CONNECTION_HANGING_TIME || '30000');
/**
 * @type {number} Amount of milliseconds we keep a tabUri known after hearing from them.
 */
const REMOVE_INACTIVE_CLIENT_TIME = parseInt(process.env.REMOVE_INACTIVE_CLIENT_TIME || '60000');
/**
 * @type (number} Amount of milliseconds to figure out when to clean out tabs which may not exist anymore.
 */
const REMOVE_INACTIVE_CLIENT_INTERVAL = parseInt(process.env.REMOVE_INACTIVE_CLIENT_INTERVAL || '10000');

function sleep( ms ) {
  return new Promise( (res) => setTimeout( res, ms ) )
}

async function updateRetry( query, { retries=1, timeout=1000 } ) {
  if ( retries < 1 ) {
    return await update(query);
  } else {
    try {
      return await update(query);
    } catch (e) {
      await  sleep( timeout );
      return await updateRetry( query, { retries: retries - 1, timeout } );
    }
  }
}

setInterval(cleanInactiveTabs, REMOVE_INACTIVE_CLIENT_INTERVAL);

async function cleanInactiveTabs() {
  const keysToClear = [];
  const now = Date.now();
  for (let key in tabs)
    if( now - tabs[key].lastHeardDate.getTime() > REMOVE_INACTIVE_CLIENT_TIME )
      keysToClear.push(key);
  console.log(`Clearing ${keysToClear.length} keys`);
  keysToClear.forEach( (key) => delete tabs[key] );
  for (let tabUri of keysToClear) {
    // TODO: store more information in the tab object so all information can be deleted
    await updateRetry(`
      PREFIX push: <http://mu.semte.ch/vocabularies/push/>
      PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
      PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
      DELETE DATA {
        ${sparqlEscapeUri(tabUri)} a push:Tab.
        }`, { retries: 60, timeout: 10000 });
  }
}

class Tab {
  messages = [];
  /** @type string? */
  uri;
  /**
   * @type string
   * The session to which this tab belongs
   */
  sessionId;
  /** @type NodeJS.Timeout? */
  timeout;
  res;
  lastHeardDate;

  constructor( uri, sessionId ) {
    this.uri = uri;
    this.sessionId = sessionId;
    this.reset();
  }

  reset() {
    this.messages = [];
    this.res = null;
    this.timeout = null;
  }

  heardClient() {
    this.lastHeardDate = new Date();
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
      this.heardClient();
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

  tabs[tabUri] ||= new Tab(tabUri, sessionId);
  tabs[tabUri].heardClient();

  // associate the tabId with the current session
  await updateRetry(`
    PREFIX push: <http://mu.semte.ch/vocabularies/push/>
    PREFIX mu: <http://mu.semte.ch/vocabularies/core/>
    PREFIX rdf: <http://www.w3.org/1999/02/22-rdf-syntax-ns#>
    INSERT DATA {
      ${sparqlEscapeUri(tabUri)}
        a push:Tab;
        mu:uuid ${sparqlEscapeString(tabUuid)};
        rdf:label ${sparqlEscapeString(`User Agent Tab ${tabUuid}`)};
        push:session ${sparqlEscapeUri(sessionId)}.
        }`, { retries: 20, timeout: 1000 });
  // return the tabId
  res
    .status(200)
    .send(JSON.stringify({data: {attributes: { tabUri }} }));
});

app.get('/messages', async (req, res) => {
  const tabUri = req.query.tab;
  const sessionId = req.get('mu-session-id');
  if( tabs[tabUri] && tabs[tabUri].sessionId === sessionId) {
    let tab = tabs[tabUri];
    tab.res = res;
    tab.registerResponseObject(res);
    tab.heardClient();
  } else {
    res
      .status(404)
      .send(JSON.stringify({errors: [
        {
          status: "404",
          title: "Tab URI not found"
        }
      ]}));
  }
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

    if ( tabs[tabUri] ) {
      // if this is not a tab anymore, then we assume the client has disconnected
      tabs[tabUri].add([{content: message,channel}]);
    }
  });

  res.status(204).send();
});

app.use(errorHandler);
