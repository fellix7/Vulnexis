// DEMO ONLY: clean dependencies, used to test the "In good shape" path.
import dayjs from 'dayjs';
import { nanoid } from 'nanoid';
console.log(`Order ${nanoid(8)} placed on ${dayjs().format('DD MMM YYYY')}`);
