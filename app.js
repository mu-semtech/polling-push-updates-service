// see https://github.com/mu-semtech/mu-javascript-template for more info

import { app, update, errorHandler, uuid, sparqlEscapeString, sparqlEscapeUri } from 'mu';

app.get('/tabUri', async (req, res) => {
  // construct a new tabId
  const tabUuid = uuid();
  const tabUri = `http://services.redpencil.io/polling-push-updates/tab-ids/${tabUuid}`;
  const sessionId = req.get("mu-session-id");

  // associate the tabId with the current session
  await update(`
    PREFIX push: <http://mu.semte.ch/vocabularies/core/push/>
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

app.post('/delta', async (req, res) => {
  // We look for anything that is a push:Update
});

app.use(errorHandler);
