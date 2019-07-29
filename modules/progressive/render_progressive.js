

fillToggle = 0;

getRenderProgressiveState = function(target){


	if(typeof renderProgressiveMap === "undefined"){
		renderProgressiveMap = new Map();
	}

	//let start = now()

	if(!renderProgressiveMap.has(target)){
		let ssIndirectCommand = gl.createBuffer();
		let ssFillCommands = gl.createBuffer();
		let icBytes = 5 * 4;
		gl.namedBufferData(ssIndirectCommand, icBytes, new ArrayBuffer(icBytes), gl.DYNAMIC_DRAW);
		gl.namedBufferData(ssFillCommands, 10 * icBytes, new ArrayBuffer(10 * icBytes), gl.DYNAMIC_DRAW);

		let ssFillFixed = gl.createBuffer();
		gl.namedBufferData(ssFillFixed, 64, new ArrayBuffer(64), gl.DYNAMIC_DRAW);

		let ssTimestamps = gl.createBuffer();
		gl.namedBufferData(ssTimestamps, 24, new ArrayBuffer(24), gl.DYNAMIC_DRAW);

		let reprojectBuffer = new GLBuffer();

		let vboCapacity = 30 * 1000 * 1000;
		let vboBytes = vboCapacity * 16;

		let buffer = new ArrayBuffer(vboBytes);
		let attributes = [
			new GLBufferAttribute("position", 0, 3, gl.FLOAT, gl.FALSE, 12, 0),
			new GLBufferAttribute("value", 1, 4, gl.INT, gl.FALSE, 4, 12, {targetType: "int"}),
			new GLBufferAttribute("index", 2, 4, gl.INT, gl.FALSE, 4, 16, {targetType: "int"}),
		];
		
		reprojectBuffer.setEmptyInterleaved(attributes, vboBytes);

		let fboPrev = new Framebuffer();

		let csFillFixed = null;
		{ // create time estimation shader
			let path = `${rootDir}/modules/progressive/compute_fill_fixed.cs`;
			let shader = new Shader([{type: gl.COMPUTE_SHADER, path: path}]);
			shader.watch();
			csFillFixed = shader;
		}

		let csFillRemaining = null;
		{ // create time estimation shader
			let path = `${rootDir}/modules/progressive/compute_fill_remaining.cs`;
			let shader = new Shader([{type: gl.COMPUTE_SHADER, path: path}]);
			shader.watch();
			csFillRemaining = shader;
		}



		let state = {
			ssIndirectCommand: ssIndirectCommand,
			ssTimestamps: ssTimestamps,
			ssFillFixed: ssFillFixed,
			ssFillCommands: ssFillCommands,
			csFillFixed: csFillFixed,
			csFillRemaining: csFillRemaining,
			reprojectBuffer: reprojectBuffer,
			round: 0, 
			fboPrev: fboPrev,
			pointclouds: new Map(),
		};

		renderProgressiveMap.set(target, state);
	}

	//let end = now();
	//let duration = end - start;
	//log(`getRenderProgressiveState(): ${duration}s`);

	return renderProgressiveMap.get(target);
};

renderPointCloudProgressive = function(pointcloud, view, proj, target){

	GLTimerQueries.mark("render-progressive-start");

	let {shReproject, shAdd, csCreateIBO} = pointcloud;
	let state = getRenderProgressiveState(target);
	let {ssIndirectCommand, ssTimestamps, reprojectBuffer, fboPrev} = state;

	{ // start timestamp to ssTimestamps
		let qtStart = gl.createQuery();
		gl.queryCounter(qtStart, gl.TIMESTAMP);
		gl.bindBuffer(gl.QUERRY_BUFFER, ssTimestamps);
		gl.getQueryObjectui64Indirect(qtStart, gl.QUERY_RESULT, 0);
		gl.bindBuffer(gl.QUERRY_BUFFER, 0);
		gl.deleteQuery(qtStart);
	}

	

	let mat32 = new Float32Array(16);
	let transform = new Matrix4();
	let world = pointcloud.transform;
	transform.copy(Matrix4.IDENTITY);
	transform.multiply(proj).multiply(view).multiply(world);
	mat32.set(transform.elements);

	let doUpdates = true;

	let reproject = () => { // REPROJECT
		GLTimerQueries.mark("render-progressive-reproject-start");
		gl.useProgram(shReproject.program);

		gl.activeTexture(gl.TEXTURE0);
		gl.bindTexture(gradientTexture.type, gradientTexture.handle);
		if(shReproject.uniforms.uGradient){
			gl.uniform1i(shReproject.uniforms.uGradient, 0);
		}

		gl.uniformMatrix4fv(shReproject.uniforms.uWorldViewProj, 1, gl.FALSE, mat32);

		gl.bindVertexArray(reprojectBuffer.vao);
		gl.bindBuffer(gl.DRAW_INDIRECT_BUFFER, ssIndirectCommand);

		gl.drawArraysIndirect(gl.POINTS, 0);

		gl.bindVertexArray(0);

		GLTimerQueries.mark("render-progressive-reproject-end");
		GLTimerQueries.measure("render.progressive.p1_reproject", "render-progressive-reproject-start", "render-progressive-reproject-end");
		//GLTimerQueries.measure("render.progressive.reproject", "render-progressive-reproject-start", "render-progressive-reproject-end", (duration) => {
		//	let ms = (duration * 1000).toFixed(3);

		//	setDebugValue("gl.render.progressive.reproject", `${ms}ms`);
		//});
	}


	let fill = () => { // FILL PASS

		GLTimerQueries.mark("render-progressive-fill-start");

		{ // COMPUTE FILL FIXED
			GLTimerQueries.mark("render-progressive-fill-compute-fixed-start");
			let csFillFixed = state.csFillFixed;
			let ssFillFixed = state.ssFillFixed;
			let ssFillCommands = state.ssFillCommands;

			if(!state.pointclouds.has(pointcloud)){

				let numBatches = pointcloud.glBuffers.length;
				let buffer = new ArrayBuffer((4 + numBatches) * 4);
				let view = new DataView(buffer);

				view.setInt32(0, pointcloud.numPoints, true);
				view.setInt32(4, 0, true);
				view.setInt32(8, 1 * 1000 * 1000, true);
				view.setInt32(12, pointcloud.glBuffers.length, true);
				for(let i = 0; i < numBatches; i++){
					let buffer = pointcloud.glBuffers[i];
					view.setInt32(16 + i * 4, buffer.count, true);
					//log(buffer.count);
				}
				gl.namedBufferSubData(ssFillFixed, 0, buffer.byteLength, buffer);

				state.pointclouds.set(pointcloud, {});
			}

			gl.useProgram(csFillFixed.program);

			gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 0, ssFillFixed);
			gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 1, ssFillCommands);

			gl.memoryBarrier(gl.ALL_BARRIER_BITS);
			gl.dispatchCompute(1, 1, 1);
			gl.memoryBarrier(gl.ALL_BARRIER_BITS);


			gl.useProgram(0);

			GLTimerQueries.mark("render-progressive-fill-compute-fixed-end");
			GLTimerQueries.measure("render.progressive.p2_fill.compute_fixed", "render-progressive-fill-compute-fixed-start", "render-progressive-fill-compute-fixed-end");
			//GLTimerQueries.measure("render.progressive.compute_fixed", "render-progressive-fill-compute-fixed-start", "render-progressive-fill-compute-fixed-end", (duration) => {
			//	let ms = (duration * 1000).toFixed(3);
			//	setDebugValue("gl.render.progressive.compute_fixed", `${ms}ms`);
			//});

		}

		{ // FILL FIXED
			GLTimerQueries.mark("render-progressive-add-start");
			gl.useProgram(shAdd.program);

			{ // start add timestamp to ssTimestamps
				let qtStart = gl.createQuery();
				gl.queryCounter(qtStart, gl.TIMESTAMP);
				gl.bindBuffer(gl.QUERRY_BUFFER, ssTimestamps);
				gl.getQueryObjectui64Indirect(qtStart, gl.QUERY_RESULT, 8);
				gl.bindBuffer(gl.QUERRY_BUFFER, 0);
				gl.deleteQuery(qtStart);
			}

			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gradientTexture.type, gradientTexture.handle);
			if(shAdd.uniforms.uGradient){
				gl.uniform1i(shAdd.uniforms.uGradient, 0);
			}

			gl.uniformMatrix4fv(shAdd.uniforms.uWorldViewProj, 1, gl.FALSE, mat32);

			let buffers = pointcloud.glBuffers;

			for(let i = 0; i < buffers.length; i++){
				let buffer = buffers[i];

				gl.uniform1i(shAdd.uniforms.uOffset, i * 134 * 1000 * 1000);

				gl.bindVertexArray(buffer.vao);
				gl.bindBuffer(gl.DRAW_INDIRECT_BUFFER, state.ssFillCommands);

				gl.drawArraysIndirect(gl.POINTS, i * 4 * 4);
			}

			//{ // DEBUG
			//	let buffer = buffers[0];

			//	gl.uniform1i(shAdd.uniforms.uOffset, 0);
			//	gl.bindVertexArray(buffer.vao);
			//	gl.bindBuffer(gl.DRAW_INDIRECT_BUFFER, 0);
			//	gl.drawArrays(gl.POINTS, 21 * 1000 * 1000, 1 * 1000 * 1000);
			//}
			

			gl.bindVertexArray(0);

			{ // start timestamp to ssTimestamps
				let qtStart = gl.createQuery();
				gl.queryCounter(qtStart, gl.TIMESTAMP);
				gl.bindBuffer(gl.QUERRY_BUFFER, ssTimestamps);
				gl.getQueryObjectui64Indirect(qtStart, gl.QUERY_RESULT, 16);
				gl.bindBuffer(gl.QUERRY_BUFFER, 0);
				gl.deleteQuery(qtStart);
			}

			GLTimerQueries.mark("render-progressive-add-end");
			GLTimerQueries.measure("render.progressive.p2_fill.render_fixed", "render-progressive-add-start", "render-progressive-add-end");
			//GLTimerQueries.measure("render.progressive.add", "render-progressive-add-start", "render-progressive-add-end", (duration) => {
			//	let ms = (duration * 1000).toFixed(3);

			//	setDebugValue("gl.render.progressive.add", `${ms}ms`);
			//});
		}

		// COMPUTE FILL REMAINING 
		if(true){ 
			GLTimerQueries.mark("render-progressive-fill-compute-remaining-start");
			let csFillRemaining = state.csFillRemaining;
			let ssFillFixed = state.ssFillFixed;
			let ssFillCommands = state.ssFillCommands;

			gl.useProgram(csFillRemaining.program);

			gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 0, ssFillFixed);
			gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 1, ssFillCommands);
			gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 2, state.ssTimestamps);

			gl.memoryBarrier(gl.ALL_BARRIER_BITS);
			gl.dispatchCompute(1, 1, 1);
			gl.memoryBarrier(gl.ALL_BARRIER_BITS);

			gl.useProgram(0);

			GLTimerQueries.mark("render-progressive-fill-compute-remaining-end");
			GLTimerQueries.measure("render.progressive.p2_fill.compute_remaining", "render-progressive-fill-compute-remaining-start", "render-progressive-fill-compute-remaining-end");
			//GLTimerQueries.measure("render.progressive.compute_remaining", "render-progressive-fill-compute-remaining-start", "render-progressive-fill-compute-remaining-end", (duration) => {
			//	let ms = (duration * 1000).toFixed(3);
			//	setDebugValue("gl.render.progressive.compute_remaining", `${ms}ms`);
			//});
		}

		// FILL REMAINING
		if(true){ 
			GLTimerQueries.mark("render-progressive-add-remaining-start");
			gl.useProgram(shAdd.program);

			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gradientTexture.type, gradientTexture.handle);
			if(shAdd.uniforms.uGradient){
				gl.uniform1i(shAdd.uniforms.uGradient, 0);
			}

			gl.uniformMatrix4fv(shAdd.uniforms.uWorldViewProj, 1, gl.FALSE, mat32);

			{
				let buffers = new Uint32Array([
					gl.COLOR_ATTACHMENT0, 
					gl.COLOR_ATTACHMENT1,
				]);
				gl.drawBuffers(buffers.length, buffers);
			}

			let buffers = pointcloud.glBuffers;

			for(let i = 0; i < buffers.length; i++){
				let buffer = buffers[i];

				gl.uniform1i(shAdd.uniforms.uOffset, i * 134 * 1000 * 1000);

				gl.bindVertexArray(buffer.vao);
				gl.bindBuffer(gl.DRAW_INDIRECT_BUFFER, state.ssFillCommands);

				gl.drawArraysIndirect(gl.POINTS, i * 4 * 4);
			}
			

			gl.bindVertexArray(0);

			GLTimerQueries.mark("render-progressive-add-remaining-end");
			GLTimerQueries.measure("render.progressive.p2_fill.render_remaining", "render-progressive-add-remaining-start", "render-progressive-add-remaining-end");
			//GLTimerQueries.measure("render.progressive.add_remaining", "render-progressive-add-remaining-start", "render-progressive-add-remaining-end", (duration) => {
			//	let ms = (duration * 1000).toFixed(3);
			//	setDebugValue("gl.render.progressive.add_remaining", `${ms}ms`);
			//});
		}

		GLTimerQueries.mark("render-progressive-fill-end");
		GLTimerQueries.measure("render.progressive.p2_fill", "render-progressive-fill-start", "render-progressive-fill-end");
	}


	let createVBO = () => { // CREATE VBO
		GLTimerQueries.mark("render-progressive-ibo-start");

		gl.useProgram(csCreateIBO.program);

		let indirectData = new Uint32Array([0, 1, 0, 0, 0]);
		gl.namedBufferSubData(ssIndirectCommand, 0, indirectData.byteLength, indirectData);

		gl.bindImageTexture(0, target.textures[1], 0, gl.FALSE, 0, gl.READ_WRITE, gl.RGBA8);

		gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 1, ssIndirectCommand);

		gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 2, reprojectBuffer.vbo);

		pointcloud.glBuffers.forEach( (buffer, i) => {
			gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 3 + i, buffer.vbo);
		});


		let localSize = {
			x: 16,
			y: 16,
		};

		let groups = [
			parseInt(1 + target.width / localSize.x),
			parseInt(1 + target.height / localSize.y),
			1
		];

		if(target.samples === 2){
			groups[0] *= 2;
		}else if(target.samples === 4){
			groups[0] *= 2;
			groups[1] *= 2;
		}else if(target.samples === 8){
			groups[0] *= 4;
			groups[1] *= 2;
		}else if(target.samples === 16){
			groups[0] *= 4;
			groups[1] *= 4;
		}

		//log(groups);

		gl.memoryBarrier(gl.ALL_BARRIER_BITS);
		gl.dispatchCompute(...groups);
		gl.memoryBarrier(gl.ALL_BARRIER_BITS);

		gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 1, 0);
		gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 2, 0);
		gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 3, 0);
		gl.bindBufferBase(gl.SHADER_STORAGE_BUFFER, 4, 0);

		GLTimerQueries.mark("render-progressive-ibo-end");
		GLTimerQueries.measure("render.progressive.p3_vbo", "render-progressive-ibo-start", "render-progressive-ibo-end");
		//GLTimerQueries.measure("render.progressive.ibo", "render-progressive-ibo-start", "render-progressive-ibo-end", (duration) => {
		//	let ms = (duration * 1000).toFixed(3);
		//	setDebugValue("gl.render.progressive.ibo", `${ms}ms`);
		//});

	}

	reproject();
	fill();
	createVBO();
	//if(fillToggle === 0){
	//	fill();
	//	createVBO();
	//	//fillToggle++;
	//}else{
	//	fill();
	//	//createVBO();
	//}


	//let doLog = (frameCount % 1000) === 0 || (frameCount % 1000) === 1;
	// print estimated point budget
	if(false){
		gl.memoryBarrier(gl.ALL_BARRIER_BITS);
		// taken from https://stackoverflow.com/questions/2901102/how-to-print-a-number-with-commas-as-thousands-separators-in-javascript
		const numberWithCommas = (x) => {
			return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		let resultBuffer = new ArrayBuffer(10 * 5 * 4);
		gl.getNamedBufferSubData(state.ssFillCommands, 0, resultBuffer.byteLength, resultBuffer);
		let view = new DataView(resultBuffer);

		//log("====");

		let estimate = view.getUint32(5 * 16, true);

		//if(estimate > 1*1000*1000){
		//if(estimate < 500){
			log(numberWithCommas(estimate));
		//}
	

		//for(let i = 0; i < pointcloud.glBuffers.length; i++){

		//	let count =      view.getInt32(i * 4 * 4 + 0, true);
		//	let primCount =  view.getInt32(i * 4 * 4 + 4, true);
		//	let first =      view.getInt32(i * 4 * 4 + 8, true);

		//	//if(count > 0){
		//		log(`${i}: ${numberWithCommas(count)}, ${primCount}, ${numberWithCommas(first)}`);
		//	//}

		//}

		// let acceptedCount = new DataView(resultBuffer).getUint32(2 * 4, true);
	

		// let key = `accepted (${pointcloud.name})`;
		// log(key + ": " + numberWithCommas(acceptedCount));
	}

	if(false){
		gl.memoryBarrier(gl.ALL_BARRIER_BITS);
		// taken from https://stackoverflow.com/questions/2901102/how-to-print-a-number-with-commas-as-thousands-separators-in-javascript
		const numberWithCommas = (x) => {
			return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		let resultBuffer = new ArrayBuffer(16);
		gl.getNamedBufferSubData(state.ssTimestamps, 0, resultBuffer.byteLength, resultBuffer);
		let view = new DataView(resultBuffer);

		//log("====");

		let estimate = view.getUint32(4, true);
		log(estimate);
	

		//for(let i = 0; i < pointcloud.glBuffers.length; i++){

		//	let count =      view.getInt32(i * 4 * 4 + 0, true);
		//	let primCount =  view.getInt32(i * 4 * 4 + 4, true);
		//	let first =      view.getInt32(i * 4 * 4 + 8, true);

		//	//if(count > 0){
		//		log(`${i}: ${numberWithCommas(count)}, ${primCount}, ${numberWithCommas(first)}`);
		//	//}

		//}

		// let acceptedCount = new DataView(resultBuffer).getUint32(2 * 4, true);
	

		// let key = `accepted (${pointcloud.name})`;
		// log(key + ": " + numberWithCommas(acceptedCount));
	}

	if(false){
		gl.memoryBarrier(gl.ALL_BARRIER_BITS);
		// taken from https://stackoverflow.com/questions/2901102/how-to-print-a-number-with-commas-as-thousands-separators-in-javascript
		const numberWithCommas = (x) => {
			return x.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
		}

		let resultBuffer = new ArrayBuffer(10000 * 4);
		let resI32 = new Uint32Array(resultBuffer);
		gl.getNamedBufferSubData(22, 0, resultBuffer.byteLength, resultBuffer);

		//log(resI32);
		let a = Array.from(resI32);

		let max = Math.max(...a);
		let min = Math.min(...a);

		//log(a)

		//log(new Array(resI32));

		log(`targetCounts - max: ${max}, min: ${min}`);
	
		let acceptedCount = new DataView(resultBuffer).getInt32(0, true);
		//log("=====");
		//log("accepted: " + numberWithCommas(acceptedCount));

		let key = `accepted (${pointcloud.name})`;
		//log(key + ": " + numberWithCommas(acceptedCount));
		//setDebugValue("accepted", numberWithCommas(acceptedCount));
		//log(numberWithCommas(acceptedCount));
	}

	
	gl.useProgram(0);

	fboPrev.setSize(target.width, target.height);
	fboPrev.setNumColorAttachments(target.numColorAttachments);

	gl.blitNamedFramebuffer(target.handle, fboPrev.handle, 
		0, 0, target.width, target.height, 
		0, 0, fboPrev.width, fboPrev.height, 
		gl.COLOR_BUFFER_BIT, gl.LINEAR);

	// let [x, y] = [900, 600];
	// let [w, h] = [200, 200];
	// gl.blitNamedFramebuffer(fboPrev.handle, target.handle, 
	// 	x, y, x + w, y + h, 
	// 	0, 0, 800, 800, 
	// 	gl.COLOR_BUFFER_BIT, gl.NEAREST);

	GLTimerQueries.mark("render-progressive-end");
	GLTimerQueries.measure("render.progressive", "render-progressive-start", "render-progressive-end");
	//GLTimerQueries.measure("render.progressive", "render-progressive-start", "render-progressive-end", (duration) => {
	//	let ms = (duration * 1000).toFixed(3);
	//	setDebugValue("gl.render.progressive", `${ms}ms`);
	//});

	//state.round++;


};

"render_progressive.js"