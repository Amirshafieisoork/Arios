# ARIOS shared implementation contract
Recovery after ephemeral environment lost original source. Independent ARIOS only. Never access Doctor Man files, databases, environment credentials, node_modules or services. All data fictitious in demo. Node24 zero-dependency standalone backend and static private Sites preview of browser-local fake data. Root owns app.mjs/api.mjs; teammates own domain, server, operations, styles/assets/docs. No publication by teammates.

Domain public/domain.mjs exports createSeedState(), publicState(state,userId), applyAction(state,userId,action,payload), projectAccess(state,userOrId,projectId), DomainError. applyAction MUTATES supplied state atomically after all validation, returns safe result. new DomainError(message,status=400,code='INVALID_INPUT'). Every server action transacts cloned state. State schemaVersion:1.
Data fields:
users [{id,name,email,role:'manager'|'worker'|'customer',department?,skill?,hourlyRate?:integerToman,rateHistory?:[{effectiveDate:ISO,hourlyRate}]}]
projects [{id,name,type,customerId,memberIds:[worker IDs],contactIds?,location,status:'active'|'attention'|'completed',progress:integer0..100,budget,contractAmount,startDate:ISO,endDate:ISO,description,phases:[{id,name,progress}],cover:'building'|'event'|'electric'|'media',clientNote}]
reports [{id,projectId,workerId,date:ISO,start:'HH:MM',end,breakMinutes,description,output,status:'submitted'|'approved'|'changes_requested'|'rejected',minutes,createdAt,version,rate,laborCost,reviewNote?,reviewedBy?}]
materials [{id,projectId,name,quantity:positive up to3 decimals,unit,unitPrice:integerToman,clientVisible:boolean,date:ISO,inventoryId?}]
invoices [{id,projectId,title,amount:positive integerToman,paid:integerToman,dueDate:ISO,status:'issued'|'paid'}]
messages [{id,projectId,authorId,text,internal:boolean,createdAt}]
tickets [{id,projectId,authorId,subject,description,status:'open'|'in_progress'|'resolved',priority:'normal'|'high',createdAt,replies:[{id,authorId,text,createdAt}],aiFingerprint?}]
inventory [{id,name,unit,quantity,minQuantity,unitPrice}]
receipts [{id,invoiceId,projectId,amount,reference,method:'manual',recordedBy,createdAt}]
audit [{id,actorId,action,entityId,createdAt,description}]
Seed IDs users manager, worker, worker2, worker3, customer, customer2. Projects p1 مجتمع آفتاب CCTV customer=customer member worker/worker2 progress75; p2 همایش ایده‌پرداز event customer null; p3 ساختمان پارس electric customer2; p4 کمپین رسانه‌ای یارا media customer null. Worker hourlyRate150000Toman. p1 invoice i1 amount40m paid40m, i2 amount48m paid15m due2026-10-22; p3 i3 amount95m paid45m. Materials p1 camera8*3600000, Cat6 180*28000 published; internal tools750000 hidden. p3 modules12*1850000 published. Current date2026-10-18 timezoneAsia/Tehran. Seed demo reports reasonable October dates.
Authorized snapshot publicState returns {user,users,projects,reports,materials,invoices,messages,tickets,inventory,receipts,audit}. Manager all, workers only assigned projects+OWN reports, no budget/contractAmount/invoices/material prices/rates/inventory/audit/receipts. Customer only customerId===self projects; strip budget and laborCost, internal messages/materials/reports/inventory/audit and any worker rates/history; contacts names role work email okay. Project laborCost only manager derived approved reports sum. Never include other projects in AI request. User itself safe and no password fields ever in state.
Actions:
project.create manager {name,type,location,customerId,memberIds,budget,contractAmount,startDate,endDate,description}; require existing customer/worker IDs; phases initial, progress0
project.update manager {id,progress,status,clientNote}
report.create worker/manager assigned project {projectId,workerId?:manager,date,start,end,breakMinutes,description,output}; minutes=end-start-break; end>start; break<duration. Historical rate from latest rateHistory effective<=date, else fallback hourlyRate if no histories; before-first history rejects. Capture rate immutable. Submitted costs0.
report.review manager {id,status:'approved'|'changes_requested'|'rejected',reviewNote}; reject overlap with approved sameworker/date across projects; repeated sameapproval idempotent audit/cost; approved immutable otherwise. cost=round(rate*minutes/60).
material.create manager {projectId,name,quantity,unit,unitPrice,clientVisible,date,inventoryId?}; validate availability+sameunit and decrement linked stock atomically.
invoice.create manager {projectId,title,amount,dueDate}
payment.record manager {invoiceId,amount,reference}; manual receipt only; reject overbalance and duplicate reference, whole money. No customer fake payment.
message.send assigned user {projectId,text,internal:boolean}; customer cannot internal.
ticket.create assigned user {projectId,subject,description,priority}; ticket.reply {id,text} scoped; ticket.update manager {id,status}
worker.create manager {name,email,department,skill}; profile only, no login
worker.rate manager {id,hourlyRate,effectiveDate}; immutable date history, reject duplicate date, integer money. Only manager sees rates/history
inventory.receive manager {id,quantity}
account.create server only manager {name,email,role:'worker'|'customer',password,projectIds}; production authenticated accounts, no sameemail; connect customer only unowned projects; member worker.

HTTP API server:
GET /api/session -> {user:null|safeUser,demo:boolean,capabilities:{ai:boolean,payments:false}}
POST /api/demo-login {userId} local demo ONLY, explicit ARIOS_DEMO=1; localhost binding and localhost source. POST /api/login {email,password}; POST /api/logout.
GET /api/state -> authorized snapshot
POST /api/actions {action,payload} -> {result,state:snapshot}
POST /api/assistant {projectId,message,history?:[{role,content}]} -> {answer,sources:[{label}],live:true,ticket?:{id,subject}}; 503 if dedicated AI not configured.
Only ARIOS_ env names; never old injected API keys. Node:sqlite persistent JSON state single row transaction; scrypt passwords session hash HttpOnly SameSite, origin check on POST, body64KiB, request/login/AI rate limits, source files unservable outside public, server startup production empty data bootstrap dedicated ARIOS_BOOTSTRAP_EMAIL/PASSWORD required, demo fictitious. createAriosServer(options) export options {demo,host,port,dbPath,bootstrapEmail,bootstrapPassword,publicOrigin,aiBaseUrl,aiApiKey,aiModel}, returns {server,url,listen,close}. API errors JSON {error:string,code} status. CLI default production, npm demo explicit.
AI independent compatible provider uses response_format json_object output {answer,needsHumanSupport}; sends only authorized selected project state, treats record instructions untrusted, no finance/tools. true -> automatic scoped ticket with question/history/answer, fingerprint idempotency so identical retry no duplicate. Never claim live AI without provider; no real keys used in tests.

Frontend shared ctx for operations.mjs:
{e:escapeHtml,n:formatFaNumber,money:returnsHTMLToman,date:FaDate,icon:name=>SVG,badge:status=>HTML,projectName:id=>str,personName:id=>str,go:hash=>void,mutate:async(action,payload)=>refreshAndResult,modal:({title,body,onSubmit(FormData),submitLabel?})=>void,toast,api,refresh,openReport(projectId?),openInvoice(projectId?),openMaterial(projectId?),capabilities,demo}
operations exports renderOperations(page,state,ctx) HTML/null and wireOperations(page,state,ctx). Pages reports,finance,inventory,support,assistant,team,analytics,settings. Root handles dashboard,projects,project/:id,messages,login,forms. All untrusted strings escaped; money is trusted HTML. Root api methods session/login/demoLogin/logout/state/action(action,payload)/assistant(payload), api.isStatic. STATIC_PREVIEW config false source and true built; demo browser adapter calls domain and localStorage, cannot real-account/AI/pay, clear banner. Source download static ./downloads/ARIOS_OS_source.zip.
