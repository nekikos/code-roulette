// Пример для Code Roulette: открой этот файл и нажми 🎰 Рулетка в строке состояния
#include <iostream>

int sum(int* a, int n) {
    int s = 0;
    for (int i = 0; i < n; i++) {
        s += a[i];
    }
    return s;
}

int maxElement(int* a, int n) {
    int best = a[0];
    for (int i = 1; i < n; i++) {
        if (a[i] > best) {
            best = a[i];
        }
    }
    return best;
}

void bubbleSort(int* a, int n) {
    for (int i = 0; i < n; i++) {
        for (int j = 0; j < n - 1 - i; j++) {
            if (a[j] > a[j + 1]) {
                int t = a[j];
                a[j] = a[j + 1];
                a[j + 1] = t;
            }
        }
    }
}

int binarySearch(int* a, int n, int x) {
    int left = 0;
    int right = n - 1;
    while (left <= right) {
        int mid = (left + right) / 2;
        if (a[mid] == x) {
            return mid;
        }
        if (a[mid] < x) {
            left = mid + 1;
        } else {
            right = mid - 1;
        }
    }
    return -1;
}

void reverseArray(int* a, int n) {
    for (int i = 0; i < n / 2; i++) {
        int t = a[i];
        a[i] = a[n - 1 - i];
        a[n - 1 - i] = t;
    }
}

int factorial(int n) {
    if (n <= 1) {
        return 1;
    }
    return n * factorial(n - 1);
}

int main() {
    int a[] = {5, 3, 8, 1, 9, 2};
    int n = 6;
    bubbleSort(a, n);
    std::cout << sum(a, n) << ' ' << maxElement(a, n) << ' ' << binarySearch(a, n, 8) << '\n';
    reverseArray(a, n);
    std::cout << factorial(5) << '\n';
    return 0;
}
