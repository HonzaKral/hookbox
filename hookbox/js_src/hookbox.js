jsio('from net import connect as jsioConnect');
jsio('from net.protocols.rtjp import RTJPProtocol');

exports.__jsio = jsio.__jsio;
exports.logging = logging;

logger.setLevel(0);


exports.connect = function(url, cookieString) {
	if (!url.match('/$')) {
		url = url + '/';
	}
	var p = new HookBoxProtocol(url, cookieString);
	if (window.WebSocket) {
		jsioConnect(p, 'websocket', {url: url.replace('http://', 'ws://') + 'ws' });
		p.connectionLost = bind(p, '_connectionLost', 'websocket');
	}
	else {
		jsioConnect(p, 'csp', {url: url + 'csp'})
		p.connectionLost = bind(p, '_connectionLost', 'csp');
	}
	return p;
}

var Subscription = Class(function(supr) {
	// Public API

	this.init = function(args) {
		this.channelName = args.channel_name;
		this.history = args.history;
		this.historySize = args.history_size;
		this.state = args.state;
		this.presence = args.presence;
		this.canceled = false;
	}

	this.onPublish = function(frame) { }
	this.onSubscribe = function(frame) {}
	this.onUnsubscribe = function(frame) {}
	this.onState = function(frame) {}

	this.frame = function(name, args) {
		logger.debug('received frame', name, args);
		switch(name) {
			case 'PUBLISH':
				if (this.historySize) { 
					this.history.push(["PUBLISH", { user: args.user, payload: args.payload}]) 
					while (this.history.length > this.historySize) { 
						this.history.shift(); 
					}
				}
				this.onPublish(args);
				break;
			case 'UNSUBSCRIBE':
				if (this.historySize) { 
					this.history.push(["UNSUBSCRIBE", { user: args.user}]) 
					while (this.history.length > this.historySize) { 
						this.history.shift(); 
					}
				}
				
				for (var i = 0, user; user = this.presence[i]; ++i) {
					if (user.name == args.user.name) {
						this.presence.splice(i, 1);
						break;
					}
				}
				this.onUnsubscribe(args);
				break;
			case 'SUBSCRIBE':
				if (this.historySize) { 
					this.history.push(["SUBSCRIBE", { user: args.user}]) 
					while (this.history.length > this.historySize) { 
						this.history.shift(); 
					}
				}
				this.presence.push(args.user);
				this.onSubscribe(args);
				break;
			case 'STATE_UPDATE':
				for (var i = 0, key; key = args.deletes[i]; ++i) {
					delete this.state[key];
				}
				for (key in args.updates) {
					this.state[key] = args.updates[key];
				}
				this.onState(args);
				break;
		}
	}
	
	this.cancel = function() {
		if (!this.canceled) {
			logger.debug('calling this._onCancel()');
			this._onCancel();
		}
	}

	// Private API
	this._onCancel = function() { }


})

HookBoxProtocol = Class([RTJPProtocol], function(supr) {
	// Public api
	this.onOpen = function() { }
	this.onClose = function(err, wasConnected) { }
	this.onError = function(args) { }
	this.onSubscribed = function(name, subscription) { }
	this.onUnsubscribed = function(subscription, args) { }
	this.init = function(url, cookieString) {
		supr(this, 'init', []);
		this.url = url;
		try {
			this.cookieString = cookieString || document.cookie;
		} catch(e) {
			this.cookieString = "";
		}
		this.connected = false;

		this._subscriptions = {}
		this._buffered_subs = []
		this._publishes = []
		this._errors = {}
		this.username = null;
	}

	this.subscribe = function(channel_name) {
		if (!this.connected) {
			this._buffered_subs.push(channel_name);
		} else {
			var fId = this.sendFrame('SUBSCRIBE', {channel_name: channel_name});
		}
	}

	this.publish = function(channel_name, data) {
		if (this.connected) {
			this.sendFrame('PUBLISH', { channel_name: channel_name, payload: JSON.stringify(data) });
		} else {
			this._publishes.push([channel_name, data]);
		}

	}

	this.connectionMade = function() {
		logger.debug('connectionMade');
		this.transport.setEncoding('utf8');
		this.sendFrame('CONNECT', { cookie_string: this.cookieString });
	}

	this.frameReceived = function(fId, fName, fArgs) {
		switch(fName) {
			case 'CONNECTED':
				this.connected = true;
				this.username = fArgs.user.name;
				while (this._buffered_subs.length) {
					var chan = this._buffered_subs.shift();
					this.sendFrame('SUBSCRIBE', {channel_name: chan});
				}
				while (this._publishes.length) {
					var pub = this._publishes.splice(0, 1)[0];
					this.publish.apply(this, pub);
				}
				this.onOpen();
				break;
			case 'SUBSCRIBE':
				if (fArgs.user.name == this.username) {
					var s = new Subscription(fArgs);
					this._subscriptions[fArgs.channel_name] = s;
					s._onCancel = bind(this, function() {
						this.sendFrame('UNSUBSCRIBE', {
							channel_name: fArgs.channel_name
						});
					});
					this.onSubscribed(fArgs.channel_name, s);
					K = s;
				}
				else {
					this._subscriptions[fArgs.channel_name].frame(fName, fArgs);
				}
				break
			case 'STATE_UPDATE':
				/* FALL THROUGH */
			case 'PUBLISH':
				/* FALL THROUGH */
				var sub = this._subscriptions[fArgs.channel_name];
				sub.frame(fName, fArgs);
				break;
				
			case 'UNSUBSCRIBE':
				var sub = this._subscriptions[fArgs.channel_name];
				sub.canceled = true;
				sub.frame(fName, fArgs);
				if (fArgs.user.name == this.username) {
					delete this._subscriptions[fArgs.channel_name];
					this.onUnsubscribed(sub, fArgs);
				}
				break;
			case 'ERROR':
				this.onError(fArgs);
				break;
				
			case 'SET_COOKIE':
				document.cookie = fArgs.cookie;
				break;
		}
	}
	
	this._connectionLost = function(transportName, reason, wasConnected) {
		if (!wasConnected) {
			logger.debug('connectionFailed', transportName)
			if (transportName == 'websocket') {
				logger.debug('retry with csp');
				this.connectionLost = bind(this, '_connectionLost', 'csp');
				jsioConnect(this, 'csp', {url: this.url + 'csp'})
			}
		} else {
			logger.debug('connectionLost');
			this.connected = false;
			this.onClose();
		}
	}

	this.disconnect = function() {
		this.transport.loseConnection();
	}

})
