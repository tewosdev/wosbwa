require('./settings');
const fs = require('fs');
const pino = require('pino');
const path = require('path');
const axios = require('axios');
const chalk = require('chalk');
const readline = require('readline');
const FileType = require('file-type');
const { exec } = require('child_process');
const { Boom } = require('@hapi/boom');
const NodeCache = require('node-cache');
const { parsePhoneNumber } = require('awesome-phonenumber');
const { default: WAConnection, useMultiFileAuthState, Browsers, DisconnectReason, makeInMemoryStore, makeCacheableSignalKeyStore, fetchLatestWaWebVersion, proto, PHONENUMBER_MCC, getAggregateVotesInPollMessage } = require('@whiskeysockets/baileys');

const pairingCode = global.pairing_code || process.argv.includes('--pairing-code');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
const store = makeInMemoryStore({ logger: pino().child({ level: 'silent', stream: 'store' }) })
const question = (text) => new Promise((resolve) => rl.question(text, resolve))

global.api = (name, path = '/', query = {}, apikeyqueryname) => (name in global.APIs ? global.APIs[name] : name) + path + (query || apikeyqueryname ? '?' + new URLSearchParams(Object.entries({ ...query, ...(apikeyqueryname ? { [apikeyqueryname]: global.APIKeys[name in global.APIs ? global.APIs[name] : name] } : {}) })) : '')

const DataBase = require('./src/database');
const database = new DataBase();
(async () => {
	const loadData = await database.read()
	if (loadData && Object.keys(loadData).length === 0) {
		global.db = {
			set: {},
			users: {},
			game: {},
			groups: {},
			database: {},
			...(loadData || {}),
		}
		await database.write(global.db)
	} else {
		global.db = loadData
	}
	
	setInterval(async () => {
		if (global.db) await database.write(global.db)
	}, 30000)
})();

const { GroupUpdate, GroupParticipantsUpdate, MessagesUpsert, Solving } = require('./src/message');
const { isUrl, generateMessageTag, getBuffer, getSizeMedia, fetchJson, await, sleep } = require('./lib/function');

/*
	* Create By Tewos
	* Follow https://github.com/tewosdev
	* Whatsapp : wa.me/62895325627676
*/

async function startTewosBot() {
	const { state, saveCreds } = await useMultiFileAuthState('tewosdev');
	const { version, isLatest } = await fetchLatestWaWebVersion();
	const msgRetryCounterCache = new NodeCache();
	const level = pino({ level: 'silent' })
	
	const getMessage = async (key) => {
		if (store) {
			const msg = await store.loadMessage(key.remoteJid, key.id);
			return msg?.message || ''
		}
		return {
			conversation: 'Halo Saya Tewos Bot'
		}
	}
	
	const tewos = WAConnection({
		isLatest,
		//version: [2, 3000, 1015901307],
		logger: level,
		printQRInTerminal: !pairingCode,
		browser: Browsers.ubuntu('Chrome'),
		auth: {
			creds: state.creds,
			keys: makeCacheableSignalKeyStore(state.keys, level),
		},
		transactionOpts: {
			maxCommitRetries: 10,
			delayBetweenTriesMs: 10,
		},
		getMessage,
		syncFullHistory: true,
		maxMsgRetryCount: 15,
		msgRetryCounterCache,
		retryRequestDelayMs: 10,
		defaultQueryTimeoutMs: 0,
		connectTimeoutMs: 60000,
		keepAliveIntervalMs: 10000,
		generateHighQualityLinkPreview: true,
	})
	
	if (pairingCode && !tewos.authState.creds.registered) {
		let phoneNumber;
		async function getPhoneNumber() {
			phoneNumber = await question('Please type your WhatsApp number : ');
			phoneNumber = phoneNumber.replace(/[^0-9]/g, '')
			
			if (!parsePhoneNumber(phoneNumber).valid && phoneNumber.length < 6) {
				console.log(chalk.bgBlack(chalk.redBright('Start with your Country WhatsApp code') + chalk.whiteBright(',') + chalk.greenBright(' Example : 62xxx')));
				await getPhoneNumber()
			}
		}
		
		setTimeout(async () => {
			await getPhoneNumber()
			await exec('rm -rf ./tewosdev/*')
			let code = await tewos.requestPairingCode(phoneNumber);
			console.log(`Your Pairing Code : ${code}`);
		}, 3000)
	}
	
	store.bind(tewos.ev)
	
	await Solving(tewos, store)
	
	tewos.ev.on('creds.update', saveCreds)
	
	tewos.ev.on('connection.update', async (update) => {
		const { connection, lastDisconnect, receivedPendingNotifications } = update
		if (connection === 'close') {
			const reason = new Boom(lastDisconnect?.error)?.output.statusCode
			if (reason === DisconnectReason.connectionLost) {
				console.log('Connection to Server Lost, Attempting to Reconnect...');
				startTewosBot()
			} else if (reason === DisconnectReason.connectionClosed) {
				console.log('Connection closed, Attempting to Reconnect...');
				startTewosBot()
			} else if (reason === DisconnectReason.restartRequired) {
				console.log('Restart Required...');
				startTewosBot()
			} else if (reason === DisconnectReason.timedOut) {
				console.log('Connection Timed Out, Attempting to Reconnect...');
				startTewosBot()
			} else if (reason === DisconnectReason.badSession) {
				console.log('Delete Session and Scan again...');
				startTewosBot()
			} else if (reason === DisconnectReason.connectionReplaced) {
				console.log('Close current Session first...');
				startTewosBot()
			} else if (reason === DisconnectReason.loggedOut) {
				console.log('Scan again and Run...');
				exec('rm -rf ./tewosdev/*')
				process.exit(1)
			} else if (reason === DisconnectReason.Multidevicemismatch) {
				console.log('Scan again...');
				exec('rm -rf ./tewosdev/*')
				process.exit(0)
			} else {
				tewos.end(`Unknown DisconnectReason : ${reason}|${connection}`)
			}
		}
		if (connection == 'open') {
			console.log('Connected to : ' + JSON.stringify(tewos.user, null, 2));
		}
		if (receivedPendingNotifications == 'true') {
			console.log('Please wait About 1 Minute...')
			tewos.ev.flush()
		}
	});
	
	tewos.ev.on('contacts.update', (update) => {
		for (let contact of update) {
			let id = tewos.decodeJid(contact.id)
			if (store && store.contacts) store.contacts[id] = { id, name: contact.notify }
		}
	});
	
	tewos.ev.on('call', async (call) => {
		let botNumber = await tewos.decodeJid(tewos.user.id);
		if (db.set[botNumber].anticall) {
			for (let id of call) {
				if (id.status === 'offer') {
					let msg = await tewos.sendMessage(id.from, { text: `Saat Ini, Kami Tidak Dapat Menerima Panggilan ${id.isVideo ? 'Video' : 'Suara'}.\nJika @${id.from.split('@')[0]} Memerlukan Bantuan, Silakan Hubungi Owner :)`, mentions: [id.from]});
					await tewos.sendContact(id.from, global.owner, msg);
					await tewos.rejectCall(id.id, id.from)
				}
			}
		}
	});
	
	tewos.ev.on('groups.update', async (update) => {
		await GroupUpdate(tewos, update, store);
	});
	
	tewos.ev.on('group-participants.update', async (update) => {
		await GroupParticipantsUpdate(tewos, update, store);
	});
	
	tewos.ev.on('messages.upsert', async (message) => {
		await MessagesUpsert(tewos, message, store);
	});

	return tewos
}

startTewosBot()

let file = require.resolve(__filename)
fs.watchFile(file, () => {
	fs.unwatchFile(file)
	console.log(chalk.redBright(`Update ${__filename}`))
	delete require.cache[file]
	require(file)
});
