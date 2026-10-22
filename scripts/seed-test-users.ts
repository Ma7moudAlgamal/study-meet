import { createClient } from '@supabase/supabase-js'
import dotenv from 'dotenv'
dotenv.config({ path: '.env.production' })

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!, // the secret key, not publishable
  { auth: { autoRefreshToken: false, persistSession: false } }
)

async function getCourseId(code: string): Promise<string> {
  const { data, error } = await supabase
    .from('courses')
    .select('id')
    .eq('course_code', code)
    .single()
  if (error || !data) throw new Error(`Course not found: ${code}`)
  return data.id
}

async function findAuthUserId(email: string): Promise<string | undefined> {
  for (let page = 1; ; page++) {
    const { data, error } = await supabase.auth.admin.listUsers({
      page,
      perPage: 1000,
    })

    if (error) throw error

    const existing = data.users.find(user => user.email?.toLowerCase() === email.toLowerCase())
    if (existing) return existing.id
    if (data.users.length < 1000) return undefined
  }
}

const TEST_USERS = [
  {
    email: 'alice.admin@mail.utoronto.ca',
    password: 'testpassword123',
    first_name: 'Mahmoud',
    last_name: 'Admin',
    gender: 'Male',
    is_admin: true,
    courseCodes: ['CSC207H5', 'CSC148H5'],
  },
  {
    email: 'bob.male@mail.utoronto.ca',
    password: 'testpassword123',
    first_name: 'Bob',
    last_name: 'Male',
    gender: 'Male',
    is_admin: false,
    courseCodes: ['CSC207H5', 'CSC148H5', 'CSC258H5'],
  },
  {
    email: 'carol.female@mail.utoronto.ca',
    password: 'testpassword123',
    first_name: 'Carol',
    last_name: 'Female',
    gender: 'Female',
    is_admin: false,
    courseCodes: ['CSC207H5', 'MAT102H5'],
  },
  {
    email: 'dana.female2@mail.utoronto.ca',
    password: 'testpassword123',
    first_name: 'Dana',
    last_name: 'Female2',
    gender: 'Female',
    is_admin: false,
    // Intentionally different courses from Carol — tests course visibility
    courseCodes: ['CSC263H5', 'MAT232H5'],
  },
  {
    email: 'sam.prefernot@mail.utoronto.ca',
    password: 'testpassword123',
    first_name: 'Sam',
    last_name: 'PreferNot',
    gender: 'Prefer not to say',
    is_admin: false,
    courseCodes: ['CSC207H5', 'STA256H5'],
  },
]

async function seedUsers() {
  console.log('Fetching course IDs from database...')
  
  // Fetch all required course IDs dynamically inside the async function
  const csc148 = await getCourseId('CSC148H5')
  const csc207 = await getCourseId('CSC207H5')
  const csc258 = await getCourseId('CSC258H5')
  const csc263 = await getCourseId('CSC263H5')
  const mat102 = await getCourseId('MAT102H5')
  const mat232 = await getCourseId('MAT232H5')
  const sta256 = await getCourseId('STA256H5')

  const courseMap: Record<string, string> = {
    'CSC148H5': csc148,
    'CSC207H5': csc207,
    'CSC258H5': csc258,
    'CSC263H5': csc263,
    'MAT102H5': mat102,
    'MAT232H5': mat232,
    'STA256H5': sta256,
  }

  for (const user of TEST_USERS) {
    console.log(`\nCreating ${user.email}...`)

    const userMetadata = {
      first_name: user.first_name,
      last_name: user.last_name,
      gender: user.gender,
    }
    const { data, error } = await supabase.auth.admin.createUser({
      email: user.email,
      password: user.password,
      email_confirm: true, // skip the magic link step for test accounts
      user_metadata: userMetadata,
    })

    let userId = data.user?.id
    if (error || !userId) {
      const existingUserId = await findAuthUserId(user.email)
      if (!existingUserId) {
        throw new Error(`Auth user creation failed for ${user.email}: ${error?.message ?? 'no user returned'}`)
      }

      const { error: updateError } = await supabase.auth.admin.updateUserById(existingUserId, {
        password: user.password,
        email_confirm: true,
        user_metadata: userMetadata,
      })
      if (updateError) {
        throw new Error(`Auth user update failed for ${user.email}: ${updateError.message}`)
      }
      userId = existingUserId
      console.log(`  ✓ Existing auth user updated`)
    } else {
      console.log(`  ✓ Auth user created`)
    }

    const { error: profileError } = await supabase.from('users').upsert({
      id: userId,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      gender: user.gender,
      is_admin: user.is_admin,
    }, { onConflict: 'id' })

    if (profileError) {
      throw new Error(`Profile creation failed for ${user.email}: ${profileError.message}`)
    }
    console.log(`  ✓ Profile created`)

    const { error: deleteCoursesError } = await supabase
      .from('user_courses')
      .delete()
      .eq('user_id', userId)
    if (deleteCoursesError) {
      throw new Error(`Could not reset courses for ${user.email}: ${deleteCoursesError.message}`)
    }

    const userCourseIds = user.courseCodes.map(code => courseMap[code])
    const enrollments = userCourseIds.map(courseId => ({
      user_id: userId,
      course_id: courseId,
    }))

    const { error: courseError } = await supabase
      .from('user_courses')
      .insert(enrollments)

    if (courseError) {
      throw new Error(`Course enrollment failed for ${user.email}: ${courseError.message}`)
    }
    console.log(`  ✓ Enrolled in ${user.courseCodes.length} courses`)
  }

  console.log('\nDone.')
}

seedUsers().catch((error: unknown) => {
  console.error('Failed to seed test users:', error)
  process.exitCode = 1
})