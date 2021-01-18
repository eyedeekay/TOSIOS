
i2p:
	git checkout .
	sed -i "s|from 'http';|from '@redhog/node-i2p';|g" packages/server/src/index.ts
	sed -i 's|server.listen(PORT)|server.listen({})|g' packages/server/src/index.ts
	sed -i 's|Listening on |Listening on:`, |g' packages/server/src/index.ts
	sed -i 's|ws://localhost:$${PORT}`|server.session.DESTINATION|g' packages/server/src/index.ts
	docker build -t tosios/i2p .
	docker run -d --name tosiosi2p --network=host tosios/i2p
