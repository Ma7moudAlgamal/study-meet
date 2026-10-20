import dotenv from 'dotenv'
import { createClient } from '@supabase/supabase-js'

dotenv.config({ path: '.env.cloud' })

const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const TEST_EMAILS = [
  'alice.admin@mail.utoronto.ca',
  'bob.male@mail.utoronto.ca',
  'carol.female@mail.utoronto.ca',
  'dana.female2@mail.utoronto.ca',
  'sam.prefernot@mail.utoronto.ca',
]

async function cleanup() {
  console.log('Cleaning up test users from cloud...')

  for (const email of TEST_EMAILS) {
    const { data: authUsers } = await admin.auth.admin.listUsers()
    const user = authUsers?.users.find(u => u.email === email)

    if (user) {
      await admin.auth.admin.deleteUser(user.id)
      // Deleting the auth user cascades to public.users via ON DELETE CASCADE
      console.log(`  ✓ Deleted ${email}`)
    } else {
      console.log(`  – Not found: ${email}`)
    }
  }

  console.log('Done.')
}

cleanup()