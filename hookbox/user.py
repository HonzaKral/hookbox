import eventlet
class User(object):
    def __init__(self, server, name):
        self.server = server
        self.name = name
        self.connections = []
        self.channels = []
        self._temp_cookie = ""
        self.info = {}

    def __eq__(self, other):
        return isinstance(other, User) and self.name == other.name

    def serialize(self):
        return {
            'channels': [ chan.name for chan in self.channels ],
            'connections': [ conn.id for conn in self.connections ],
            'name': self.name
        }

    def get_info(self):
        return dict(name=self.name, **self.info)
        
    def add_connection(self, conn):
        self.connections.append(conn)
        conn.user = self
        # call later...
        eventlet.spawn(self._send_initial_subscriptions, conn)
        
    def _send_initial_subscriptions(self, conn):
        for channel in self.channels:
            frame = channel._build_subscribe_frame(self)
            conn.send_frame('SUBSCRIBE', frame)
            
    def remove_connection(self, conn):
        self.connections.remove(conn)
        if not self.connections:
            # each call to user_disconnected might result in an immediate call
            # to self.channel_unsubscribed, thus modifying self.channels and
            # messing up our loop. So we loop over a copy of self.channels...
            
            for channel in self.channels[:]:
                channel.user_disconnected(self)
#            print 'tell server to remove user...'
            # so the disconnect callback has a cookie
            self._temp_cookie = conn.get_cookie()
            self.server.remove_user(self.name)
            
    def channel_subscribed(self, channel):
        self.channels.append(channel)
        
    def channel_unsubscribed(self, channel):
        self.channels.remove(channel)
        
    def get_name(self):
        return self.name
    
    def send_frame(self, name, args={}, omit=None):
        for conn in self.connections:
            if conn is not omit:
                conn.send_frame(name, args)

    def get_cookie(self, conn=None):
        if conn:
            return conn.get_cookie()
        
        return self._temp_cookie or ""
        
    
