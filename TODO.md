# TODO - MCP serverless con API key per Copilot Studio (sandbox)

## Obiettivo e vincoli

Implementare AWS Pricing Calculator MCP con Lambda, API Gateway REST API e
CDK. Salvare i calculator (stime) in DynamoDB tra invocazioni e cold start.
Client destinatario: Microsoft Copilot Studio.

- Profilo `lutechlab-sandbox`, account verificato `695076071513`, regione
  approvata `eu-south-1`, stack `LthAwsPricingMcpStack`.
- Traffico previsto: meno di 1000 richieste/giorno. Chromium escluso.
- CloudWatch Logs: retention di 7 giorni per tutti i log group del servizio,
  inclusi Lambda e API Gateway, da configurare esplicitamente in CDK.
- Decisione del 2026-11-05: API key generata da API Gateway, inviata in
  `x-api-key`, associata a uno usage plan dedicato. Nessuna Lambda authorizer,
  Secrets Manager o autenticazione OAuth/JWT in questo design.
- **Eccezione accettata esplicitamente dall'utente, solo per la sandbox**:
  AWS raccomanda di non usare API key come autenticazione/autorizzazione.
  Lo usage plan controlla utilizzo, non identita o accesso per utente; quota
  e throttling sono best-effort, non un limite garantito di spesa.
  Non presentare questo design come autenticazione equivalente a un authorizer.
  Prima di un uso fuori sandbox serve una nuova decisione sulla sicurezza.
  [Fonte AWS](https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-api-usage-plans.html).
- Usare [aws-serverless-deployer](./.github/agents/aws-serverless-deployer.agent.md)
  e la [skill di deploy](./.github/skills/aws-serverless-deploy/SKILL.md).
- Codice, dipendenze, test, configurazione e documentazione solo in `deploy/`.
  Upstream read-only senza approvazione esplicita.
  Eccezione approvata il 2026-11-05: solo store DynamoDB e relativi test,
  per letture consistenti e scritture condizionali con controllo versione.
- Non creare risorse, pubblicare artifact/chiavi, fare bootstrap o deploy
  fino all'approvazione della relativa fase.
- Non inserire mai valori di chiavi in Git, prompt, output CDK, log o esempi.
- Completare le checkbox solo con evidenza verificabile; riportare blocchi e
  comandi non eseguiti. Conservare gli ID T01-T36 per continuita.

## 1. Confermare client e perimetro

Prerequisiti: nessuno. La verifica documentale guida il design; la prova
nel tenant e' T31, dopo il deploy e lo smoke test T30. La compatibilita
runtime del client rimane un rischio esplicito, non un prerequisito circolare.

- [ ] T01 - Verificare sulla documentazione Microsoft corrente Streamable HTTP
  e API key in Header, nome `x-api-key`. Registrare fonti, data e configurazione.
  La checkbox resta aperta fino alla verifica del wizard e delle richieste
  realmente emesse dal client in T31.
- [ ] T02 - Se la verifica documentale o T31 falliscono, fermarsi e chiedere
  una decisione. Non sostituire header, OAuth/JWT o authorizer in silenzio.
  Registrare l'esito anche se nessun cambio di design e' necessario.
- [x] T03 - Confermato dall'utente il 2026-11-05: credenziale tecnica condivisa,
  nessun isolamento per utente. Un chiamante con la chiave valida opera nel
  medesimo perimetro degli altri; gli estimate ID non sono autorizzazione.
- [x] T04 - STS il 2026-11-05: profilo `lutechlab-sandbox`, account
  `695076071513`. Utente: `eu-south-1`, stack `LthAwsPricingMcpStack`,
  meno di 1000 richieste/giorno, Playwright/Chromium escluso.
  La regione di default del profilo e' diversa: passare sempre `eu-south-1`.

Criterio per proseguire: T03-T04 confermati e compatibilita documentale
esaminata. T01/T02 si chiudono solo dopo T31. Nessun deploy autorizzato.
Vedere [evidenze e checklist client](./deploy/T01-copilot-studio-compatibility.md).

## 2. Validare architettura e costi

Prerequisiti: T03-T04 e verifica documentale T01; prova tenant differita a T31.

- [ ] T05 - Leggere entrypoint HTTP, store DynamoDB e catalogo attuali.
  Scegliere adapter/wrapper sotto `deploy/`: il server avvia Express e non
  esporta un handler Lambda pronto. Verificare packaging e readiness.
  Stato 2026-11-05: codice letto, smoke locale superato; proposto handler
  Node con child Express su loopback. Packaging/adaptation ancora da provare.
- [ ] T06 - REST API scelta per le API key native. Verificare integrazione
  Lambda, JSON/SSE, notifiche, header e timeout effettivi in `eu-south-1`.
  Non assumere streaming o durata illimitata. Cambi di API richiedono accordo.
  Stato 2026-11-05: proposta BUFFERED, deadline handler 25 s, Lambda 28 s,
  API 29 s; SSE locale verificato, integrazione AWS e client non ancora provati.
- [x] T07 - Progettare API key obbligatoria su tutti i metodi applicativi e
  uno usage plan dedicato al solo stage sandbox. Escludere Function URL,
  altri stage/metodi pubblici e percorsi che bypassano il controllo della key.
  Nessuna Lambda authorizer; mantenere esplicita l'eccezione AWS accettata.
  Design documentato il 2026-11-05: stage sandbox, POST/GET/DELETE keyed,
  nessun catch-all/Function URL; enforcement da testare in T26/T30.
- [ ] T08 - Definire schema DynamoDB, TTL opzionale, retention e comportamento
  degli aggiornamenti concorrenti. Non confondere persistenza e isolamento.
  Correzione upstream approvata il 2026-11-05 e implementata: ConsistentRead,
  versioni condizionali, upgrade legacy e conflitti espliciti senza retry.
  Regression store: 28 test superati; prova AWS ancora T25/T32. Prima del
  rollout fermare writer vecchi senza condizioni. Schema/retention CDK
  restano da approvare in T10.
- [x] T09 - Stimare REST API, Lambda, DynamoDB, log, artifact, trasferimento
  dati ed eventuale registry. Escludere authorizer e Secrets Manager.
  Documentare regione, volumi, dimensioni dati, durata/memoria e prezzi;
  non assumere idoneita al Free Tier o promettere costo zero.
  Prezzi Milan da Pricing MCP il 2026-11-05: USD 2.16/mese con 30000 richieste,
  1 GB Lambda, media 2 s; USD 6.85 con media 10 s. Include PITR e log 7 giorni.
  [Ipotesi, tariffe, prove e design proposto](./deploy/README.md#design-review-t05-t10-2026-11-05).
- [ ] T10 - Presentare adapter, limiti, costi e rischio sandbox; ottenere
  accordo sul design definitivo prima di generare IaC. Esplicitare come
  escludere il tool Chromium senza modificare upstream.

Criterio: design motivato e approvato, costi con ipotesi e limiti misurabili.

## 3. Implementare controllo API key e rotazione

Prerequisiti: T10.

- [ ] T11 - Definire in CDK API key generata da API Gateway e usage plan
  dedicato. Non specificare il valore in IaC, output, manifest o codice.
  Nessun segreto Secrets Manager o permesso di lettura chiavi per la Lambda.
- [ ] T12 - Configurare `apiKeySourceType=HEADER` e `apiKeyRequired=true`
  su tutti i metodi applicativi. Il client invia il valore grezzo in
  `x-api-key`, senza prefisso Bearer. Non accettare credenziali via query.
  Parsing/confronto della chiave sono gestiti da API Gateway, non da codice.
- [ ] T13 - Verificare il wiring key/plan/stage/metodi, evitando metodi
  alternativi senza key. Distinguere 403 da errori del servizio e verificare
  in T30 che chiavi mancanti/errate non invochino la Lambda.
- [ ] T14 - Definire throttling del servizio, quota del plan e monitoraggio
  della spesa. Documentare propagazione delle modifiche alle API key e tempo
  massimo di revoca da misurare in T33; nessuna cache authorizer da configurare.
- [ ] T15 - Documentare rotazione: nuova key sul medesimo plan, aggiornamento
  connessione, finestra di sovrapposizione limitata e disabilitazione vecchia
  key. Gestire la rotazione anche nell'IaC per non riattivare chiavi revocate.
- [ ] T16 - Procedura per trasferire la key nel campo protetto della
  connessione tramite operatore autorizzato, senza stamparla nel transcript
  o salvarla nel progetto. Limitare con IAM la lettura del valore delle key.

Criterio: key obbligatoria, privilegi minimi, rotazione e revoca verificabili;
l'eccezione sandbox non viene presentata come autenticazione.

## 4. Implementare servizio e stack CDK

Prerequisiti: T10; wiring API key dipendente da T11-T14.

- [ ] T17 - Progetto CDK isolato con manifest, lockfile, type-check e test.
  Packaging riproducibile da staging sotto `deploy/`; non sovrascrivere
  bundle, ZIP o manifest upstream.
- [ ] T18 - Includere catalogo e dipendenze runtime, anche peer SDK DynamoDB.
  Impostare `MCP_TRANSPORT=http`, `HOST`/`PORT` per l'adapter,
  `ESTIMATES_STORE=dynamodb` e `ESTIMATES_TABLE`.
- [ ] T19 - Definire tabella DynamoDB compatibile con lo store. Collegare
  `ESTIMATES_TABLE` e concedere solo i permessi necessari sulla tabella.
  Collegare REST API e Lambda con IAM minimo, key e usage plan.
  Definire concurrency, timeout, memoria, cifratura e retention dati.
  Impostare retention CloudWatch Logs a 7 giorni su tutti i log group.
  Nessuna VPC/NAT o ulteriore endpoint pubblico senza necessita e approvazione.
- [ ] T20 - Preservare POST `/mcp`, GET/DELETE previsti, header MCP e
  notifiche. Non inventare `/health` upstream; readiness solo nell'adapter.
- [ ] T21 - Verificare sessioni, richieste simultanee e riuso del singleton
  per processo Lambda. Concurrency riservata a 1 non e' automaticamente
  necessaria: provare il modello di esecuzione dell'adapter.
  Testare aggiornamenti concorrenti, non solo salvataggio DynamoDB.
- [ ] T22 - Chromium escluso come approvato. Implementare e testare
  l'esclusione esplicita del tool dipendente nel solo deployment, senza
  pubblicizzarlo come funzionante. Se richiede editing upstream, fermarsi
  e chiedere approvazione.

Criterio: artifact riproducibili, upstream invariato, tutti i metodi MCP
richiedono key e la limitazione Chromium e' esplicita.

## 5. Test e validazione prima del deploy

Prerequisiti: T11-T22.

- [ ] T23 - Test della configurazione API key e della redazione dei log.
  Preparare smoke test per chiave valida, assente, vuota, errata, disabilitata
  e header malformati/duplicati; il controllo nativo si prova su AWS in T30.
  Non presentare test unitari locali come prova di API Gateway.
- [ ] T24 - Test adapter con fixture REST API: `initialize`,
  `notifications/initialized`, `tools/list` e tool read-only.
  Verificare JSON-RPC, content type, JSON/SSE dove previsto.
- [ ] T25 - Test persistenza tra processi/invocazioni, cold start,
  aggiornamenti concorrenti e perimetro condiviso concordato.
- [ ] T26 - Test template: key richiesta su tutti i metodi, associazione
  key/plan/stage, assenza di bypass, IAM, tabella e retention.
  Verificare `RetentionInDays: 7` su tutti i log group CloudWatch del servizio.
  Nessuna Lambda authorizer/Secrets Manager; log senza `x-api-key` o
  Authorization, niente chiavi negli output e niente logging completo richieste.
- [ ] T27 - Type-check, suite deployment, `cdk synth`, validazione template
  e compliance con `awsiac`. Risolvere errori prima di procedere; qualsiasi
  eccezione sandbox va documentata puntualmente, non soppressa in blocco.
  Stato 2026-11-06: type-check, 41 test e synth superati; eccezione temporanea
  per advisory CDK/minimatch approvata. Validazione IaC/compliance non completata.

Criterio: test e template validati; prova client ancora esplicitamente T31.

## 6. Deploy approvato e collaudo Copilot Studio

Prerequisiti: T27 e approvazione esplicita delle modifiche AWS.

- [ ] T28 - Verificare identita/regione, mostrare costi e `cdk diff`.
  Chiedere approvazione distinta per bootstrap, pubblicazione artifact,
  creazione chiavi e deploy. Profilo `lutechlab-sandbox`, regione `eu-south-1`.
- [x] T29 - Deploy approvato, CloudFormation a stato terminale, endpoint e
  output non sensibili. Verificare key/usage plan/stage, tabella attiva e
  configurazione DynamoDB della Lambda.
  Evidenza 2026-11-06: deploy eseguito dall'utente; stack CREATE_COMPLETE,
  Lambda Active/Successful, DynamoDB ACTIVE/PAY_PER_REQUEST e PITR ENABLED.
  Key v1 abilitata e associata al piano; entrambi i log group retention 7 giorni.
- [ ] T30 - Endpoint reale: chiave assente/errata/disabilitata respinta prima
  della Lambda applicativa; key valida, handshake, discovery e tool read-only.
  Registrare metriche/log senza valori di chiavi. Eseguire anche i casi T23.
  Evidenza parziale 2026-11-06: smoke live 13 controlli superati, handshake
  200 SSE, notifica 202 vuota, 9 tool e get_server_info funzionanti.
  POST/GET/DELETE senza key o con key errata 403; POST con key vuota 403;
  GET/DELETE con key valida 405. Cold start osservato nei REPORT Lambda.
  Restano key disabilitata, header duplicati/malformati e percorso lungo;
  persistenza cross-invocation/cold-start e rotazione restano T32/T33.
- [ ] T31 - Dopo T29-T30, chiudere T01/T02. Wizard MCP nel tenant:
  Tools > Add a tool > New tool > Model Context Protocol; API key, Header,
  nome `x-api-key`. Operatore inserisce key nel campo protetto.
  Provare discovery e invocazione dall'agente reale; verificare ogni richiesta
  osservata, incluse notifiche e GET/DELETE se emessi, senza registrare key.
  Seguire [checklist T01](./deploy/T01-copilot-studio-compatibility.md).
  Se il client altera/omette l'header, applicare T02. Concordare tool ammessi
  e conferme per effetti esterni; non pubblicare un'integrazione non verificata.
- [ ] T32 - Create/update tra invocazioni distinte, salvataggio DynamoDB e
  rilettura della stessa stima dopo cold start. Export, build e computed cost
  salvano copie esterne: approvazione dedicata, non smoke test innocui.
- [ ] T33 - Rotazione da client reale: nuova key funzionante, vecchia
  disabilitata e respinta entro il tempo concordato; misurare propagazione.
- [ ] T34 - Runbook sotto `deploy/`: setup client, diagnosi 403, metriche,
  costi, rotazione, revoca d'emergenza, rollback e conservazione dati.
  Dichiarare eccezione sandbox e requisito di auth per altri ambienti.
  Nessun destroy automatico.

## 7. Test nel Copilot personale e condivisione ai colleghi

- [ ] T35 - Testare i prompt nel proprio Microsoft 365 Copilot con l'agente
  AWS Pricing Calculator, non solo nel pannello Test di Copilot Studio.
  Prerequisiti: accettazione T31, verifica dei controlli di sicurezza ancora
  aperti e approvazione esplicita della pubblicazione nel canale destinatario.
  Verificare disponibilita del canale, licenze e policy del tenant.
  Provare ricerca servizi, campi EC2 Milano e creazione/aggiornamento/validazione
  di una stima di test; registrare chiamate effettive, esiti e fedelta dei
  riepiloghi. Nessun build/export senza conferma dedicata; nessuna API key
  nei prompt. Non assumere che il test in Studio provi il canale personale.
- [ ] T36 - Condividere l'agente ai colleghi dopo T35 e approvazione esplicita
  di destinatari e permessi. Iniziare con un gruppo pilota identificato,
  verificare licenze, policy e accesso al canale; concedere uso dell'agente,
  non modifica o accesso alla chiave salvo necessita approvata.
  Dichiarare il perimetro sandbox: credenziale condivisa, nessun isolamento
  delle stime per utente, costi non limitati in modo garantito.
  Verificare con un collega accesso e prompt read-only, controllare eventuali
  richieste di connessione senza distribuire la chiave, e documentare revoca
  dell'accesso e responsabile del supporto. Se serve isolamento o uso fuori
  sandbox, fermarsi e approvare prima un nuovo design di sicurezza.

## Definition of done

- [ ] Copilot Studio usa il servizio reale con API key protetta e ruotabile.
- [ ] Richieste senza key valida non raggiungono la Lambda; nessun bypass.
- [ ] Stato persistente, MCP e tool concordati funzionano su Lambda.
- [ ] Tabella CDK collegata; stime rilette tra invocazioni e dopo cold start.
- [ ] Revoca misurata, log privi di chiavi, costi e limiti documentati.
- [ ] Eccezione key-only esplicita e limitata alla sandbox, non autenticazione.
- [ ] Deployment e test sotto `deploy/`; runbook aggiornato, upstream invariato.
- [ ] Prompt verificati nel Copilot personale sul canale effettivo (T35).
- [ ] Agente condiviso al gruppo approvato e accesso pilota verificato (T36).

## Prompt da passare a Copilot

> Usa aws-serverless-deployer e segui TODO.md in ordine di dipendenza.
> Prepara MCP per Copilot Studio con REST API, API key generata in x-api-key,
> usage plan dedicato, Lambda e DynamoDB. Nessuna Lambda authorizer o Secrets
> Manager: key-only e' un'eccezione sandbox accettata, non autenticazione.
> Profilo lutechlab-sandbox, eu-south-1, stack LthAwsPricingMcpStack.
> Parti da verifica documentale T01 e T05-T09; prova tenant in T31 dopo deploy.
> Chromium escluso. Mantieni upstream invariato, deployment solo in deploy/.
> Checkbox solo con evidenza; design/costi approvati in T10 prima dell'IaC.
> Nessun bootstrap, pubblicazione artifact, creazione key o deploy senza consenso.
