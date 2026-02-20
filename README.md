# polling-push-updates-service
Service offering a long-polling push update bridge. It allows browser tabs to receive real-time notifications about updates in the backend via a polling mechanism.

A browser tab registers itself, then "hangs" on a long-lived HTTP request waiting for messages. Other services push messages by writing RDF triples to the triplestore. By listening to delta messages containing push updates this service then delivers the messages to the waiting tab.

## Getting started
### Add the service to your stack
This service assumes a regular semantic.works stack including mu-authorization and delta-notifier.

Add the following snippet to your `docker-compose.yml`

``` yaml
services:
  polling-push-update:
    image: semtech/polling-push-updates
    environment:
      DEFAULT_MU_AUTH_SCOPE: "http://services.semantic.works/polling-push-updates"
```

Next, add the following config to mu-authorization in `./config/authorization/config.lisp`

``` common-lisp
(define-prefixes
  :mu "http://mu.semte.ch/vocabularies/core/"
  :service "http://services.semantic.works/"
  :push "http://mu.semte.ch/vocabularies/push/"
  :rdf "http://www.w3.org/1999/02/22-rdf-syntax-ns#")

(define-graph tab-ids ("http://mu.semte.ch/graphs/tab-ids" :sparql nil)
  ("push:Tab"
   -> "push:session"
   -> "mu:uuid"
   -> "rdf:type"
   -> "rdf:label"))

(supply-allowed-group "public")

(with-scope "service:polling-push-updates"
  (grant (write)
         :to tab-ids
         :for "public"))
```

Add a new delta rule to `./config/delta/rules.js`

``` javascript
export default [
  {
    match: {
      // we expect the full body to be sent in this case
      object: { value: "http://mu.semte.ch/vocabularies/push/Update" },
    },
    callback: {
      url: "http://polling-push-update/delta",
      method: "POST",
    },
    options: {
      resourceFormat: "v0.0.1",
      gracePeriod: 100,
      foldEffectiveChanges: false,
      ignoreFromSelf: false,
    },
  }
]
```

Restart database and delta-notifier and start up the new service

``` javascript
docker compose restart database delta-notifier
docker compose up -d
```

## Reference
### Configuration
#### Environment variables
The following settings can be configured via environment variables

- **`EXTRA_WAIT`**: Amount of milliseconds to wait after a push has received before sending the information to a client (default: `100`)
- **`CONNECTION_HANGING_TIME`**: Amount of milliseconds we leave a long-polling connection hanging when we don't have data yet (default: `30000` = 30 seconds)
- **`REMOVE_INACTIVE_CLIENT_TIME`**: Amount of milliseconds we keep a tab URI known after hearing from them (default: `60000` = 60 seconds)
- **`REMOVE_INACTIVE_CLIENT_INTERVAL`**: Amount of milliseconds to figure out when to clean out tabs which may not exist anymore (default: `10000` = 10 seconds)

### REST API
#### GET /tabUri
Creates a new tab and associates it with the user's session.

Returns 200 OK with the new tab URI

``` json
{ 
  "data": [
    {
      "type": "tabs",
      "id": "b0da18b0-051a-49b1-8623-4c2f686cda4e",
      "attributes": {
        "uri": "http://services.redpencil.io/polling-push-updates/tab-ids/b0da18b0-051a-49b1-8623-4c2f686cda4e",
      }
    }
  ]
}
```

#### GET /messages?tab=tabUri
Long-polling endpoint. The client calls this repeatedly to receive messages. 

The connection is held open until either:
- a message arrives (sent after a `EXTRA_TIME` debounce delay)
- `CONNECTION_HANGING_TIME` passes with no messages

Returns 200 OK with a response body like

``` json
{ 
  "data": [
    {
      "type": "push-updates",
      "id": "843982b0-48a8-43f3-b324-27bdbd61388e",
      "attributes": {
        "content": "Content of the push update",
        "channel": "Channel of the push update"
      }
    }
  ]
}
```

Returns 404 Not Found if the give tab URI is not known or not associated with the user's session.

#### POST /delta
Delta handling endpoint listening for push updates to send to the client.

Listens for delta's of type `push:Update` and forwards them to the tabs set as target.

Returns 204 No Content.

### Data model
#### Prefixes
| Prefix | URI                                     |
|--------|-----------------------------------------|
| `push` | `http://mu.semte.ch/vocabularies/push/` |

#### Tabs
##### Class
`push:Tab`
##### Properties
| Name    | Predicate      | Range           | Definition                        |
|---------|----------------|-----------------|-----------------------------------|
| session | `push:session` | `rdfs:Resource` | User's session related to the tab |

#### Push update
##### Class
`push:Update`
##### Properties
| Name    | Predicate      | Range        | Definition                    |
|---------|----------------|--------------|-------------------------------|
| target  | `push:target`  | `push:Tab`   | Target tab of the push update |
| channel | `push:channel` | `xsd:string` |                               |
| message | `push:message` | `xsd:string` |                               |
