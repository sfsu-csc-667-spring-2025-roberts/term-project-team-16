We are Team 16

1. Dorian Lam (Leader)
2. Ammar Almeher (akalmeher)
3. Francisco Beas (javibeas)
4. Daniel O (ryklin2)

I am sorry I did not finish all the requirements I guess. I should have planned better I didn't realize quite how many weird bugs there were and I worked through them in the wrong order.
This was a good learning experience though, I definitely think I overrated the blackbox-ness of websockets and types and was actually able to make changes on my own towards the end while i used LLMs to work on issues I understood less.

Node.js: We recommend using the latest LTS version. You can download it from https://nodejs.org/
npm: (Node Package Manager) This is usually installed with Node.js.
PostgreSQL: You'll need a running PostgreSQL server. You can download it from https://www.postgresql.org/download/
Setup Instructions

1. Clone the Repository
git clone https://github.com/sfsu-csc-667-spring-2025-roberts/term-project-team-16.git
cd term-project-team-16

3. Configure PostgreSQL Database
Create a PostgreSQL database:

You can use a GUI tool like pgAdmin or the psql command-line tool.
Create a new database (e.g., bs_card_game).
Set up database credentials:
this private repo features a .env, but feel free to use your own.

The database initialization script (src/server/db/init.ts) will create the necessary tables (user, game, game_players, card, cards_held, messages, sessions) and populate the card table if it's empty.

3. Install Dependencies
Navigate to the project's root directory in your terminal and run the following command to install the project dependencies listed in package.json:
npm install
This will install both runtime dependencies like express, socket.io, pg, bcrypt, etc., and development dependencies like nodemon, typescript, ts-node.

5. Initialize the Database
The application will attempt to initialize the database schema when the server starts. This includes creating tables and populating initial data like the card deck.

6. Running the Project
There are two primary ways to run the application:

For development (with automatic server restarts on file changes):
npm run start:dev
This command uses nodemon and ts-node to execute src/server/index.ts.

For production or standard start:
npm run start
This command uses ts-node to execute src/server/index.ts.

Once the server is running, it will typically be accessible at http://localhost:3000 (or the port specified in your .env file if you've set PORT there).
