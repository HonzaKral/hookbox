import logging
import uuid
from eventlet import api
from config import config
from errors import ExpectedException
import rtjp

class HookboxConn(rtjp.RTJPConnection):
    logger = logging.getLogger('RTJPConnection')
    
    def __init__(self, server, sock):
        rtjp.RTJPConnection.__init__(self, sock)
        self.server = server
        self.state = 'initial'
        self.cookies = None
        self.cookie_string = None
        self.cookie_id = None
        self.id = str(uuid.uuid4()).replace('-', '')
        api.spawn(self._run)
        
    def get_cookie(self):
        return self.cookie_string
        
    def get_id(self):
        return self.id
    
    def get_cookie_id(self):
        return self.cookie_id
    
    def _close(self):
        if self.state == 'connected':
            self.server.closed(self)
        
    def _run(self):
        while True:
            try:
                fid, fname, fargs= self.recv_frame()
            except:
                self.logger.warn("Error reading frame", exc_info=True)
                continue
            f = getattr(self, 'frame_' + fname, None)
            if f:
                try:
                        f(fid, fargs)
                except ExpectedException, e:
                    self.send_error(fid, e)
                except Exception, e:
                    self.logger.warn("Unexpected error: %s", e, exc_info=True)
                    self.send_error(fid, e)
            else:
                self._default_frame(fid, fname, fargs)                
            
    def _default_frame(fid, fname, fargs):
        pass
    
    def frame_CONNECT(self, fid, fargs):
        if self.state != 'initial':
            return self.send_error(fid, "Already logged in")
        if 'cookie_string' not in fargs:
            raise ExpectedException("Missing cookie_string")

        self.cookie_string = fargs['cookie_string']
        self.cookies = parse_cookies(fargs['cookie_string'])
        self.cookie_id = self.cookies.get(config['cookie_identifier'], None)
        self.server.connect(self)
        self.state = 'connected'
        self.send_frame('CONNECTED')
    
    def frame_SUBSCRIBE(self, fid, fargs):
        if self.state != 'connected':
            return self.send_error(fid, "Not connected")
        if 'channel_name' not in fargs:
            return self.send_error(fid, "channel_name required")
        channel = self.server.get_channel(self, fargs['channel_name'])
        channel.subscribe(self)
            
    def frame_UNSUBSCRIBE(self, fid, fargs):
        if self.state != 'connected':
            return self.send_error(fid, "Not connected")
        if 'channel_name' not in fargs:
            return self.send_error(fid, "channel_name required")
        channel = self.server.get_channel(self, fargs['channel_name'])
        channel.unsubscribe(self)
            
    def frame_PUBLISH(self, fid, fargs):
        if self.state != 'connected':
            return self.send_error(fid, "Not connected")
        if 'channel_name' not in fargs:
            return self.send_error(fid, "channel_name required")
        channel = self.server.get_channel(self, fargs['channel_name'])
        channel.publish(self, fargs.get('payload', 'null'))

def parse_cookies(cookieString):
    output = {}
    for m in cookieString.split('; '):
        try:
            k,v = m.split('=', 1)
            output[k] = v
        except:
            continue
    return output