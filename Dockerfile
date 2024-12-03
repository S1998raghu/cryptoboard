# Use an official Node.js runtime as a parent image
FROM node:16

# Set the working directory in the container
WORKDIR /app

# Copy package.json and package-lock.json to the container
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application to the container
COPY . .

# Build the frontend if there is one included in the same project
RUN npm run build || echo "No build script, skipping build step"

# Expose the backend server port
EXPOSE 8082

# Start the application
CMD npm start
