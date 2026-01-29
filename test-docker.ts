import Docker from 'dockerode';

// Detect Windows and use appropriate connection
const isWindows = process.platform === 'win32';
const docker = isWindows 
  ? new Docker({ host: 'localhost', port: 2375 })
  : new Docker({ socketPath: '/var/run/docker.sock' });

console.log('Testing Docker connection...');
console.log(`Platform: ${process.platform}`);
console.log(`Connection: ${isWindows ? 'TCP (localhost:2375)' : 'Unix socket'}\n`);

async function testDockerConnection() {
  try {
    // Test 1: Ping Docker
    console.log('1. Pinging Docker daemon...');
    await docker.ping();
    console.log('   ✅ Docker is responding');

    // Test 2: Get Docker info
    console.log('\n2. Getting Docker info...');
    const info = await docker.info();
    console.log(`   ✅ Docker version: ${info.ServerVersion}`);
    console.log(`   ✅ Containers running: ${info.ContainersRunning}`);
    console.log(`   ✅ Total containers: ${info.Containers}`);
    console.log(`   ✅ Images: ${info.Images}`);

    // Test 3: List images
    console.log('\n3. Checking for node:20-alpine image...');
    const images = await docker.listImages();
    const nodeImage = images.find(img => 
      img.RepoTags && img.RepoTags.some(tag => tag.includes('node:20-alpine'))
    );
    
    if (nodeImage) {
      console.log('   ✅ node:20-alpine image found');
    } else {
      console.log('   ⚠️  node:20-alpine image not found');
      console.log('   Run: docker pull node:20-alpine');
    }

    // Test 4: Try creating and removing a test container
    console.log('\n4. Testing container creation...');
    const container = await docker.createContainer({
      Image: 'node:20-alpine',
      Cmd: ['/bin/sh', '-c', 'echo "Hello from Docker"'],
    });
    console.log('   ✅ Container created:', container.id.substring(0, 12));

    console.log('\n5. Starting container...');
    await container.start();
    console.log('   ✅ Container started');

    console.log('\n6. Waiting for container to finish...');
    await container.wait();
    console.log('   ✅ Container finished');

    console.log('\n7. Getting container logs...');
    const logs = await container.logs({ stdout: true, stderr: true });
    console.log('   ✅ Output:', logs.toString().trim());

    console.log('\n8. Removing container...');
    await container.remove();
    console.log('   ✅ Container removed');

    console.log('\n✅ All Docker tests passed! The agent should work correctly.\n');

  } catch (error: any) {
    console.error('\n❌ Docker test failed!\n');
    console.error('Error:', error.message);
    console.error('\nTroubleshooting:');
    console.error('1. Make sure Docker is running: docker ps');
    console.error('2. Check socket path: ls -la /var/run/docker.sock');
    console.error('3. Check permissions: groups | grep docker');
    console.error('4. Try: sudo usermod -aG docker $USER && newgrp docker');
    process.exit(1);
  }
}

testDockerConnection();