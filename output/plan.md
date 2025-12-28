Step-by-step PLAN to create a simple hello-world Node app in a new folder called demo-app:

1. Create a new folder named `demo-app` at the project root.

2. Inside `demo-app`, create a `package.json` file with minimal content to define the Node.js app:
   - Set the name to "demo-app"
   - Set the version to "1.0.0"
   - Set the main entry point to `index.js`
   - Add a start script that runs `node index.js`

3. Inside `demo-app`, create an `index.js` file that contains a simple Node.js HTTP server or console log:
   - For simplicity, create a script that logs "Hello, world!" to the console when run.

4. Optionally, create a `.gitignore` file inside `demo-app` to ignore `node_modules` if dependencies are added later.

5. Verify the folder structure:
   - demo-app/
     - package.json
     - index.js
     - .gitignore (optional)

6. No existing files in the main project need modification.

7. After creation, the user can run `npm install` (if dependencies are added) and `npm start` inside `demo-app` to see the hello-world output.

Summary:
- Create folder `demo-app`
- Create `package.json` with basic metadata and start script
- Create `index.js` with console log "Hello, world!"
- Optionally create `.gitignore`
- No modifications to existing files needed