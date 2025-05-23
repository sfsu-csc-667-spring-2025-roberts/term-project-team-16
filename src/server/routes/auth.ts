// src/server/routes/auth.ts
import express, { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import pool from '../config/database';

const router = express.Router();
const saltRounds = 10; 

// GET /auth/register - Display registration page
router.get('/register', (req: Request, res: Response) => {
    if (req.session.userId) { // If already logged in, redirect
        return res.redirect('/');
    }
    res.render('register', { error: null });
});

// POST /auth/register - Handle registration submission
router.post('/register', async (req: Request, res: Response) => {
    const { email, username, password, confirmPassword } = req.body;

    if (!email || !username || !password || !confirmPassword) {
        return res.status(400).render('register', { error: 'All fields are required.' });
    }

    if (password !== confirmPassword) {
        return res.status(400).render('register', { error: 'Passwords do not match.' });
    }

    // yes I did just take the auto complete, yes I can't believe vscode copilot thinks thats reasonable
    if (password.length < 6) {
         return res.status(400).render('register', { error: 'Password must be at least 6 characters long.' });
    }

    const client = await pool.connect();
    try {
        // Check if email or username already exists
        const existingUser = await client.query(
            'SELECT * FROM "user" WHERE email = $1 OR username = $2',
            [email, username]
        );

        if (existingUser.rows.length > 0) {
            let errorMessage = '';
            if (existingUser.rows[0].email === email) {
                errorMessage = 'Email already in use.';
            } else {
                errorMessage = 'Username already taken.';
            }
            return res.status(409).render('register', { error: errorMessage });
        }

        // Hash the password
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // add user to table
        const newUserResult = await client.query(
            'INSERT INTO "user" (email, username, password) VALUES ($1, $2, $3) RETURNING user_id, username',
            [email, username, hashedPassword]
        );

        const newUser = newUserResult.rows[0];

        // insta log in
        req.session.userId = newUser.user_id;
        req.session.username = newUser.username;

        // redirect
        res.redirect('/'); 

    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).render('register', { error: 'An error occurred during registration. Please try again.' });
    } finally {
        client.release();
    }
});

// GET /auth/login - gets login page, look I was really new to this whole typescript backend thing, I have done a js backend once before
router.get('/login', (req: Request, res: Response) => {
  if (req.session.userId) { // If already logged in, redirect
      return res.redirect('/');
  }
  res.render('login', { error: null, message: null });
});

// POST /auth/login - login submit
router.post('/login', async (req: Request, res: Response) => {
  const { usernameOrEmail, password } = req.body;

  if (!usernameOrEmail || !password) {
      return res.status(400).render('login', { error: 'Username/Email and password are required.', message: null });
  }

  const client = await pool.connect();
  try {
      // find user by username or email
      const userResult = await client.query(
          'SELECT * FROM "user" WHERE username = $1 OR email = $1',
          [usernameOrEmail]
      );

      if (userResult.rows.length === 0) {
          return res.status(401).render('login', { error: 'Invalid credentials.', message: null });
      }

      const user = userResult.rows[0];

      // Compare submitted password with stored hashed password
      const passwordMatch = await bcrypt.compare(password, user.password);

      if (!passwordMatch) {
          return res.status(401).render('login', { error: 'Invalid credentials.', message: null });
      }

      // Passwords match, set up session
      req.session.userId = user.user_id;
      req.session.username = user.username;

      // Optional: Update signed_in status (though session is the primary check)
      await client.query('UPDATE "user" SET signed_in = TRUE WHERE user_id = $1', [user.user_id]);


      // Redirect to a protected page or home page
      // You might want to redirect to the page the user was trying to access
      // or a default logged-in page like a dashboard or lobby
      const redirectUrl = (req.session as any).returnTo || '/'; // Example of redirecting back
      delete (req.session as any).returnTo; // Clear the returnTo path
      res.redirect(redirectUrl);


  } catch (error) {
      console.error('Login error:', error);
      res.status(500).render('login', { error: 'An error occurred during login. Please try again.', message: null });
  } finally {
      client.release();
  }
});


// GET /auth/logout - Handle logout
router.get('/logout', async (req: Request, res: Response) => {
  if (req.session.userId) {
      const client = await pool.connect();
      try {
          // Optional: Update signed_in status in DB
          await client.query('UPDATE "user" SET signed_in = FALSE WHERE user_id = $1', [req.session.userId]);

          // Destroy the session
          req.session.destroy((err) => {
              if (err) {
                  console.error('Session destruction error:', err);
                  return res.status(500).send('Could not log out, please try again.');
              }
              // Also clear the cookie on the client side
              res.clearCookie('connect.sid'); // The default session cookie name, adjust if you changed it
              res.redirect('/auth/login?message=Successfully logged out');
          });
      } catch (dbError) {
          console.error('Logout DB error:', dbError);
          // Even if DB update fails, still try to destroy session
          req.session.destroy((err) => {
               res.clearCookie('connect.sid');
               if (err) {
                   return res.status(500).send('Could not log out, please try again.');
               }
               res.redirect('/auth/login?message=Successfully logged out');
          });
      } finally {
          client.release();
      }
  } else {
      res.redirect('/auth/login');
  }
});


export default router;
