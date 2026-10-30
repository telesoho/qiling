import http.server, socketserver, os
os.chdir(r"C:\Users\telesoho\prjs\my\qiling")
port = 8765
Handler = http.server.SimpleHTTPRequestHandler
socketserver.TCPServer.allow_reuse_address = True
print("SERVING http://127.0.0.1:%d/design/anim/demo-tracks.html" % port, flush=True)
print("  also  http://127.0.0.1:%d/design/anim/诗琚-吊起/demo-pickup.html" % port, flush=True)
with socketserver.TCPServer(("127.0.0.1", port), Handler) as httpd:
    httpd.serve_forever()