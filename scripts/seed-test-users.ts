import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.local' })

// Uses your LOCAL supabase credentials — never run this against production
const supabase = createClient(
  'http://127.0.0.1:54321',
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // the secret key, not publishable
  { auth: { autoRefreshToken: false, persistSession: false } }
)

// Hardcoded course IDs matching seed.sql
const COURSES = {
  CSC148: '00000000-0000-0000-0000-000000000001',
  CSC207: '00000000-0000-0000-0000-000000000002',
  CSC258: '00000000-0000-0000-0000-000000000003',
  CSC263: '00000000-0000-0000-0000-000000000004',
  MAT102: '00000000-0000-0000-0000-000000000005',
  MAT232: '00000000-0000-0000-0000-000000000006',
  STA256: '00000000-0000-0000-0000-000000000007',
}

const TEST_USERS = [
  {
    email: 'alice.admin@mail.utoronto.ca',
    password: 'testpassword123',
    first_name: 'Mahmoud',
    last_name: 'Admin',
    gender: 'Male',
    is_admin: true,
    courses: [COURSES.CSC207, COURSES.CSC148],
  },
  {
    email: 'bob.male@mail.utoronto.ca',
    password: 'testpassword123',
    first_name: 'Bob',
    last_name: 'Male',
    gender: 'Male',
    is_admin: false,
    courses: [COURSES.CSC207, COURSES.CSC148, COURSES.CSC258],
  },
  {
    email: 'carol.female@mail.utoronto.ca',
    password: 'testpassword123',
    first_name: 'Carol',
    last_name: 'Female',
    gender: 'Female',
    is_admin: false,
    courses: [COURSES.CSC207, COURSES.MAT102],
  },
  {
    email: 'dana.female2@mail.utoronto.ca',
    password: 'testpassword123',
    first_name: 'Dana',
    last_name: 'Female2',
    gender: 'Female',
    is_admin: false,
    // Intentionally different courses from Carol — tests course visibility
    courses: [COURSES.CSC263, COURSES.MAT232],
  },
  {
    email: 'sam.prefernot@mail.utoronto.ca',
    password: 'testpassword123',
    first_name: 'Sam',
    last_name: 'PreferNot',
    gender: 'Prefer not to say',
    is_admin: false,
    courses: [COURSES.CSC207, COURSES.STA256],
  },
]

async function seedUsers() {
  for (const user of TEST_USERS) {
    console.log(`Creating ${user.email}...`)

    // createUser goes through Auth properly, which fires your
    // handle_new_user() trigger — same path as a real signup
    const { data, error } = await supabase.auth.admin.createUser({
      email: user.email,
      password: user.password,
      email_confirm: true, // skip the magic link step for test accounts
      user_metadata: {
        first_name: user.first_name,
        last_name: user.last_name,
        gender: user.gender,
      },
    })

    if (error) {
      console.error(`  ✗ Auth error for ${user.email}:`, error.message)
      continue
    }

    const userId = data.user.id
    console.log(`  ✓ Auth user created: ${userId}`)

    // Set is_admin if needed — direct DB update, safe since this is seeding
    if (user.is_admin) {
      const { error: adminError } = await supabase
        .from('users')
        .update({ is_admin: true })
        .eq('id', userId)

      if (adminError) {
        console.error(`  ✗ Failed to set is_admin:`, adminError.message)
      } else {
        console.log(`  ✓ is_admin set to true`)
      }
    }

    // Enroll in courses
    const enrollments = user.courses.map(courseId => ({
      user_id: userId,
      course_id: courseId,
    }))

    const { error: courseError } = await supabase
      .from('user_courses')
      .insert(enrollments)

    if (courseError) {
      console.error(`  ✗ Course enrollment error:`, courseError.message)
    } else {
      console.log(`  ✓ Enrolled in ${user.courses.length} courses`)
    }
  }

  console.log('\nDone.')
}

seedUsers()