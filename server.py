from http.server import HTTPServer, SimpleHTTPRequestHandler
import os

os.chdir('/Users/nguyenthimyhuyen/Desktop/Ôn từ vựng nhanh')
class CustomHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

server = HTTPServer(('0.0.0.0', 9090), CustomHandler)
print('Serving on 0.0.0.0:9090')
server.serve_forever()
